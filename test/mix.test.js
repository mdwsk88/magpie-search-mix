import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeLog } from "../src/log.js"
import { askSource, countOf, interleave, keysInTurn, mixSearch, pageKey, resetState, restFor } from "../src/mix.js"

const S = (vendor, keys = [], url = "") => ({ vendor, name: vendor, keys, url, label: vendor })
const D = S("deepseek", ["sk-deepseek-secret-1234"])
const Y = S("you")
const T = S("tavily", ["tvly-secret-abcd"])

const deepseekReply = (urls) => JSON.stringify({ results: urls.map((u, i) => ({ title: `D${i + 1}`, url: u, summary: `ds ${i + 1}` })) })
const youReply = (urls) => JSON.stringify({ results: { web: urls.map((u, i) => ({ title: `Y${i + 1}`, url: u, snippets: [`you ${i + 1}`] })), news: [] } })
const tavilyReply = (urls) => JSON.stringify({ results: urls.map((u, i) => ({ title: `T${i + 1}`, url: u, content: `tv ${i + 1}` })) })
const urls = (prefix, n) => Array.from({ length: n }, (_, i) => `https://${prefix}.example/${i + 1}`)
const ok = (body) => new Response(body, { status: 200 })

const vendorOf = (url) => (url.includes("deepseek") ? "deepseek" : url.includes("tavily") ? "tavily" : "you")
function fakeFetch(plan) {
  const calls = []
  const f = async (url, init) => {
    const v = vendorOf(url)
    calls.push({ v, url, init })
    const p = plan[v]
    if (!p) throw new Error(`unexpected ask of ${v}`)
    return typeof p === "function" ? p(url, init) : p.clone()
  }
  f.calls = calls
  return f
}

beforeEach(() => resetState())

describe("keys", () => {
  test("a refused key rests as magpie rests it, and the next key is asked", async () => {
    const two = S("tavily", ["tvly-one-1111", "tvly-two-2222"])
    let n = 0
    const f = fakeFetch({ tavily: () => (++n === 1 ? new Response('{"detail":{"error":"plan limit"}}', { status: 432 }) : ok(tavilyReply(["https://t.example"]))) })
    expect((await askSource(two, "q", 6, undefined, f)).length).toBe(1)
    expect(f.calls.map((c) => c.init.headers.Authorization)).toEqual(["Bearer tvly-one-1111", "Bearer tvly-two-2222"])
    expect(keysInTurn(two)).toEqual(["tvly-two-2222"])
  })

  test("rests: 10 minutes turned away, an hour out of credit, Retry-After held to 30 s–10 min", () => {
    expect(restFor("deepseek", 403)).toEqual({ ms: 600_000, why: "turned away" })
    expect(restFor("tavily", 432).why).toBe("out of credit")
    expect(restFor("brave", 432).why).toBe("rate limited")
    expect(restFor("you", 429, "5").ms).toBe(30_000)
    expect(restFor("you", 429, "9999").ms).toBe(600_000)
    expect(restFor("you", 429).ms).toBe(60_000)
  })

  test("several keys take turns", () => {
    const two = S("tavily", ["k1", "k2"])
    expect(keysInTurn(two)).toEqual(["k1", "k2"])
    expect(keysInTurn(two)).toEqual(["k2", "k1"])
  })
})

describe("merging", () => {
  test("a page two APIs give is kept once, by its address", () => {
    expect(pageKey("http://WWW.Example.com/a/#top")).toBe(pageKey("https://example.com/a"))
    expect(pageKey("https://example.com/a?id=1")).not.toBe(pageKey("https://example.com/a?id=2"))
  })

  test("each list's first, then each one's second, at most n", () => {
    const a = [{ url: "https://x/1", text: "" }, { url: "https://x/2", text: "a2" }, { url: "https://x/3", text: "a3" }]
    const b = [{ url: "https://y/1", text: "b1" }, { url: "http://x/1/", text: "b-dup" }, { url: "https://y/3", text: "b3" }]
    const got = interleave([a, b], 4)
    expect(got.map((p) => p.url)).toEqual(["https://x/1", "https://y/1", "https://x/2", "https://x/3"])
    expect(got[0].text).toBe("b-dup")
  })
})

describe("a mixed search", () => {
  test("asks the first two at once and takes their pages in turn; the third isn't asked", async () => {
    const f = fakeFetch({ deepseek: ok(deepseekReply(urls("d", 6))), you: ok(youReply(urls("y", 6))) })
    const got = await mixSearch({ query: "q", count: 6, sources: [D, Y, T], fetchImpl: f })
    expect(got.map((p) => p.title)).toEqual(["D1", "Y1", "D2", "Y2", "D3", "Y3"])
    expect(f.calls.map((c) => c.v).sort()).toEqual(["deepseek", "you"])
  })

  test("width 3 asks three at once", async () => {
    const f = fakeFetch({ deepseek: ok(deepseekReply(urls("d", 2))), you: ok(youReply(urls("y", 2))), tavily: ok(tavilyReply(urls("t", 2))) })
    const got = await mixSearch({ query: "q", count: 6, sources: [D, Y, T], width: 3, fetchImpl: f })
    expect(got.map((p) => p.title)).toEqual(["D1", "Y1", "T1", "D2", "Y2", "T2"])
  })

  test("one source alone is asked alone", async () => {
    const f = fakeFetch({ you: ok(youReply(urls("y", 3))) })
    expect((await mixSearch({ query: "q", count: 6, sources: [Y], fetchImpl: f })).length).toBe(3)
  })

  test("one that fails gives its place to the next", async () => {
    const f = fakeFetch({ deepseek: new Response("boom", { status: 500 }), you: ok(youReply(urls("y", 3))), tavily: ok(tavilyReply(urls("t", 3))) })
    const got = await mixSearch({ query: "q", count: 6, sources: [D, Y, T], fetchImpl: f })
    expect(got.map((p) => p.title)).toEqual(["Y1", "T1", "Y2", "T2", "Y3", "T3"])
  })

  test("one that found nothing gives its place to the next", async () => {
    const f = fakeFetch({ deepseek: ok('{"results":[]}'), you: ok(youReply(urls("y", 2))), tavily: ok(tavilyReply(urls("t", 2))) })
    const got = await mixSearch({ query: "q", count: 6, sources: [D, Y, T], fetchImpl: f })
    expect(got.map((p) => p.title)).toEqual(["Y1", "T1", "Y2", "T2"])
  })

  test("one rate limited rests, and the next search doesn't ask it", async () => {
    const f = fakeFetch({
      deepseek: new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { "retry-after": "120" } }),
      you: ok(youReply(urls("y", 3))),
      tavily: ok(tavilyReply(urls("t", 3))),
    })
    await mixSearch({ query: "q", count: 6, sources: [D, Y, T], fetchImpl: f })
    const before = f.calls.filter((c) => c.v === "deepseek").length
    const got = await mixSearch({ query: "q", count: 6, sources: [D, Y, T], fetchImpl: f })
    expect(f.calls.filter((c) => c.v === "deepseek").length).toBe(before)
    expect(got.map((p) => p.title)).toEqual(["Y1", "T1", "Y2", "T2", "Y3", "T3"])
  })

  test("one too slow gives its place to the next", async () => {
    const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
    const f = fakeFetch({ deepseek: hang, you: ok(youReply(urls("y", 2))), tavily: ok(tavilyReply(urls("t", 2))) })
    const lines = []
    const got = await mixSearch({ query: "q", count: 6, sources: [D, Y, T], fetchImpl: f, perSourceMs: 50, log: (e) => lines.push(e) })
    expect(got.map((p) => p.title)).toEqual(["Y1", "T1", "Y2", "T2"])
    expect(lines[0].asked.find((a) => a.source === "deepseek").error).toBe("no answer in time")
  })

  test("all failing is a plain error naming each, without a key or the query", async () => {
    const query = "secret project name"
    const echo = (_url, init) => new Response(JSON.stringify({ error: { message: `bad ${JSON.parse(init.body ?? "{}").query} with ${init.headers.Authorization}` } }), { status: 400 })
    const f = fakeFetch({ deepseek: echo, you: new Response("down", { status: 503 }), tavily: echo })
    const err = await mixSearch({ query, count: 6, sources: [D, Y, T], fetchImpl: f }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBeUndefined()
    for (const s of ["deepseek:", "you:", "tavily:"]) expect(err.message).toContain(s)
    expect(err.message).not.toContain(query)
    expect(err.message).not.toContain("sk-deepseek-secret-1234")
    expect(err.message).not.toContain("tvly-secret-abcd")
  })

  test("all finding nothing is no pages, not an error", async () => {
    const f = fakeFetch({ deepseek: ok('{"results":[]}'), you: ok('{"results":{"web":[],"news":[]}}'), tavily: ok('{"results":[]}') })
    expect(await mixSearch({ query: "q", count: 6, sources: [D, Y, T], fetchImpl: f })).toEqual([])
  })

  test("each source is asked for the count magpie gives, 6 when none, at most 20", async () => {
    expect([countOf(undefined), countOf(0), countOf("8"), countOf(50)]).toEqual([6, 6, 8, 20])
    const f = fakeFetch({ deepseek: ok(deepseekReply(urls("d", 12))), you: ok(youReply(urls("y", 12))) })
    const got = await mixSearch({ query: "q", count: 12, sources: [D, Y], fetchImpl: f })
    expect(got.length).toBe(12)
    expect(JSON.parse(f.calls.find((c) => c.v === "deepseek").init.body).count).toBe(12)
  })

  test("the log has times and counts, never the query or a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mixlog-"))
    const f = fakeFetch({ deepseek: new Response("nope", { status: 401 }), you: ok(youReply(urls("y", 2))), tavily: ok(tavilyReply(urls("t", 2))) })
    await mixSearch({ query: "private words", count: 6, sources: [D, Y, T], fetchImpl: f, log: makeLog(dir) })
    const line = readFileSync(join(dir, "search-mix.jsonl"), "utf8")
    const e = JSON.parse(line)
    expect(e.merged).toBe(4)
    expect(e.asked.find((a) => a.source === "deepseek").status).toBe(401)
    expect(line).not.toContain("private words")
    expect(line).not.toContain("sk-deepseek-secret-1234")
  })
})
