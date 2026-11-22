// The search APIs added with execute are asked and read the way
// magpie-websearch's providers ask and read them. Every reply here is written
// by the test: no network, no real key.

import { beforeEach, describe, expect, test } from "bun:test"
import { Refused, askSource, resetState, restFor } from "../src/mix.js"
import { REST } from "../src/vendors-rest.js"
import { USER_AGENT, VENDORS, baseOf } from "../src/vendors.js"

const src = (vendor, key = "", url = "") => ({ vendor, name: VENDORS[vendor].name, keys: key ? [key] : [], url, label: vendor })

// fake answers every request with what reply(req) says, and keeps the requests
function fake(reply) {
  const asked = []
  const f = async (url, init) => {
    const u = new URL(url)
    const req = { url, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect }
    asked.push(req)
    const r = typeof reply === "function" ? reply(req) : reply
    return r instanceof Response ? r : new Response(typeof r === "string" ? r : JSON.stringify(r), { status: 200 })
  }
  f.asked = asked
  return f
}

async function ask(vendor, key, reply, { url = "", q = "latest go", n = 6 } = {}) {
  const f = fake(reply)
  const pages = await askSource(src(vendor, key, url), q, n, undefined, f)
  const req = f.asked[0]
  expect(req.headers["User-Agent"]).toBe(USER_AGENT)
  expect(req.redirect).toBe("manual")
  return { req, asked: f.asked, pages }
}

const fail = (vendor, key, reply, { url = "", q = "q" } = {}) => askSource(src(vendor, key, url), q, 6, undefined, fake(reply)).catch((e) => e)

const page = (title, url, text, age = "") => ({ title, url, text, age })

beforeEach(() => resetState())

describe("each API asked and read its own way", () => {
  test("anysearch: a key in a bearer and data.results read; no address nobody can open", async () => {
    const reply = {
      code: 0,
      data: {
        results: [
          { title: "A", url: "https://a.example/1", content: "first" },
          { title: "B", url: "javascript:alert(1)", content: "not a page" },
          { title: "C", url: "https://c.example/2", snippet: "second" },
        ],
      },
    }
    const { req, pages } = await ask("anysearch", "as-k", reply)
    expect([req.method, req.path]).toEqual(["POST", "/v1/search"])
    expect([req.headers.Authorization, req.headers["Content-Type"]]).toEqual(["Bearer as-k", "application/json"])
    expect(req.body).toEqual({ query: "latest go", max_results: 6, format: "markdown" })
    expect(pages).toEqual([page("A", "https://a.example/1", "first"), page("C", "https://c.example/2", "second")])
  })

  test("anysearch: no key, no Authorization", async () => {
    const { req, pages } = await ask("anysearch", "", { code: 0, data: { results: [{ title: "A", url: "https://a.example" }] } })
    expect(req.headers.Authorization).toBeUndefined()
    expect(pages.length).toBe(1)
  })

  test("anysearch: a 402 says its quota is used up, never the body's words", async () => {
    const err = await fail("anysearch", "as-secret-key-1234", () => new Response('{"message":"card 4242 declined, top up in the billing portal"}', { status: 402 }))
    expect(err).toBeInstanceOf(Refused)
    expect(err.status).toBe(402)
    expect(err.message).toContain("quota")
    expect(err.message).not.toContain("4242")
    expect(err.message).not.toContain("billing portal")
    expect(err.message).not.toContain("as-secret-key-1234")
  })

  test("anysearch: an error it sends with 200 is a plain error", async () => {
    const err = await fail("anysearch", "as-k", { code: 1001, message: "query too long", request_id: "r-1" })
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("1001")
    expect(err.message).toContain("query too long")
  })

  test("bocha: its web search, webPages.value read", async () => {
    const reply = {
      code: 200,
      data: { webPages: { value: [
        { name: "B", url: "https://b.example/1", snippet: "snip", datePublished: "2026-01-02T00:00:00Z" },
        { name: "no", url: "mailto:someone@example.com", snippet: "x" },
      ] } },
    }
    const { req, pages } = await ask("bocha", "bo-k", reply)
    expect([req.method, req.path, req.headers.Authorization]).toEqual(["POST", "/v1/web-search", "Bearer bo-k"])
    expect(req.body).toEqual({ query: "latest go", count: 6, summary: false })
    expect(pages).toEqual([page("B", "https://b.example/1", "snip", "2026-01-02T00:00:00Z")])
  })

  test("bocha: a 200 with a failing code in it is a plain error", async () => {
    const err = await fail("bocha", "bo-k", { code: 403, message: "quota", log_id: "l-1" })
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("403")
    expect(err.message).toContain("quota")
  })

  test("jina: its search, no page content read back", async () => {
    const reply = { code: 200, status: 20000, data: [
      { title: "J", url: "https://j.example/1", description: "desc", publishedTime: "2026-02-01" },
      { title: "K", url: "https://j.example/2" },
    ] }
    const { req, pages } = await ask("jina", "jn-k", reply)
    expect([req.method, req.path, req.headers.Authorization, req.headers["X-Respond-With"]]).toEqual(["POST", "/search", "Bearer jn-k", "no-content"])
    expect(req.body).toEqual({ q: "latest go", num: 6 })
    expect(pages).toEqual([page("J", "https://j.example/1", "desc", "2026-02-01"), page("K", "https://j.example/2", "")])
  })

  test("jina: a 200 with a failing status is a plain error", async () => {
    const err = await fail("jina", "jn-k", { status: 40201, message: "no credit" })
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("40201")
    expect(err.message).toContain("no credit")
  })

  test("kagi: its search, data.search read", async () => {
    const reply = { data: { search: [{ title: "K", url: "https://k.example/1", snippet: "ks", time: "2026-03-01" }] } }
    const { req, pages } = await ask("kagi", "kg-k", reply)
    expect([req.method, req.path, req.headers.Authorization]).toEqual(["POST", "/api/v1/search", "Bearer kg-k"])
    expect(req.body).toEqual({ query: "latest go", workflow: "search", limit: 6 })
    expect(pages).toEqual([page("K", "https://k.example/1", "ks", "2026-03-01")])
  })

  test("kagi: an error it sends with 200 is a plain error", async () => {
    const err = await fail("kagi", "kg-k", { error: [{ code: 401, msg: "invalid key" }] })
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("invalid key")
  })

  test("keenable: with a key it asks the keyed endpoint, its title sent", async () => {
    const reply = { results: [{ title: "K", url: "https://ke.example/1", snippet: "kn", published_at: "2026-04-01" }] }
    const { req, pages } = await ask("keenable", "kn-k", reply)
    expect([req.method, req.path, req.headers["X-API-Key"], req.headers["X-Keenable-Title"]]).toEqual(["POST", "/v1/search", "kn-k", "magpie-search-mix"])
    expect(req.body).toEqual({ query: "latest go", max_results: 6 })
    expect(pages).toEqual([page("K", "https://ke.example/1", "kn", "2026-04-01")])
  })

  test("keenable: no key asks its public endpoint, still titled", async () => {
    const { req, pages } = await ask("keenable", "", { results: [{ title: "K", url: "https://ke.example/1", description: "pub" }] })
    expect([req.path, req.headers["X-API-Key"], req.headers["X-Keenable-Title"]]).toEqual(["/v1/search/public", undefined, "magpie-search-mix"])
    expect(pages).toEqual([page("K", "https://ke.example/1", "pub")])
  })

  test("linkup: its search, an image left out (it has no page to open)", async () => {
    const reply = { results: [
      { type: "text", name: "L", url: "https://l.example/1", content: "lc" },
      { type: "image", name: "pic", url: "https://l.example/2", content: "png" },
    ] }
    const { req, pages } = await ask("linkup", "lu-k", reply)
    expect([req.path, req.headers.Authorization]).toEqual(["/v1/search", "Bearer lu-k"])
    expect(req.body).toEqual({ q: "latest go", depth: "fast", outputType: "searchResults", maxResults: 6 })
    expect(pages).toEqual([page("L", "https://l.example/1", "lc")])
  })

  test("metaso: its search, a page's link its address", async () => {
    const reply = { webpages: [{ title: "M", link: "https://m.example/1", snippet: "ms", date: "2026-05-01" }] }
    const { req, pages } = await ask("metaso", "me-k", reply)
    expect([req.path, req.headers.Authorization]).toEqual(["/api/v1/search", "Bearer me-k"])
    expect(req.body).toEqual({ q: "latest go", scope: "webpage", size: 6, concise: true })
    expect(pages).toEqual([page("M", "https://m.example/1", "ms", "2026-05-01")])
  })

  test("moonshot: its tools search on its own site", async () => {
    const reply = { search_results: [{ title: "Mo", url: "https://mo.example/1", snippet: "sn", date: "2026-06-01" }] }
    const { req, pages } = await ask("moonshot", "ma-k", reply)
    expect([req.url.split("?")[0], req.headers.Authorization]).toEqual(["https://api.moonshot.ai/v1/tools/search", "Bearer ma-k"])
    expect(req.body).toEqual({ text_query: "latest go", limit: 6 })
    expect(pages).toEqual([page("Mo", "https://mo.example/1", "sn", "2026-06-01")])
  })

  test("moonshot-cn: the same protocol on its own site, its id with a hyphen", async () => {
    expect(VENDORS["moonshot-cn"].name).toBe("Moonshot CN")
    const { req, pages } = await ask("moonshot-cn", "mc-k", { search_results: [] })
    expect([req.url.split("?")[0], req.headers.Authorization]).toEqual(["https://api.moonshot.cn/v1/tools/search", "Bearer mc-k"])
    expect(req.body).toEqual({ text_query: "latest go", limit: 6 })
    expect(pages).toEqual([])
  })

  test("ollama: its web search by key", async () => {
    const reply = { results: [{ title: "O", url: "https://o.example/1", content: "oc" }] }
    const { req, pages } = await ask("ollama", "ol-k", reply)
    expect([req.url.split("?")[0], req.headers.Authorization]).toEqual(["https://ollama.com/api/web_search", "Bearer ol-k"])
    expect(req.body).toEqual({ query: "latest go", max_results: 6 })
    expect(pages).toEqual([page("O", "https://o.example/1", "oc")])
  })

  test("perplexity: its search, its own date else when it last saw the page", async () => {
    const reply = { results: [
      { title: "P", url: "https://p.example/1", snippet: "ps", date: "2026-07-01" },
      { title: "Q", url: "https://p.example/2", snippet: "qs", last_updated: "2026-07-02" },
    ] }
    const { req, pages } = await ask("perplexity", "pp-k", reply)
    expect([req.path, req.headers.Authorization]).toEqual(["/search", "Bearer pp-k"])
    expect(req.body).toEqual({ query: "latest go", max_results: 6, search_type: "web" })
    expect(pages.map((p) => p.age)).toEqual(["2026-07-01", "2026-07-02"])
  })

  test("querit: its search, a snippet else its sentences", async () => {
    const reply = { results: { result: [
      { title: "Qu", url: "https://q.example/1", snippet: "qs", page_age: "2026-08-01" },
      { title: "Qv", url: "https://q.example/2", sentence: ["one", "two"] },
    ] } }
    const { req, pages } = await ask("querit", "qu-k", reply)
    expect([req.path, req.headers.Authorization]).toEqual(["/v1/search", "Bearer qu-k"])
    expect(req.body).toEqual({ query: "latest go", count: 6 })
    expect(pages).toEqual([page("Qu", "https://q.example/1", "qs", "2026-08-01"), page("Qv", "https://q.example/2", "one two")])
  })

  test("querit: an error it sends with 200 is a plain error", async () => {
    const err = await fail("querit", "qu-k", { error_code: 401, error_msg: "bad key", search_id: "s-1" })
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("bad key")
  })

  test("serpapi: GET with its key in the query, organic_results read", async () => {
    const reply = { search_metadata: { status: "Success" }, organic_results: [
      { title: "S", link: "https://s.example/1", snippet: "ss", date: "2026-09-01" },
      { title: "x", link: "https://s.example/2" },
    ] }
    const { req, pages } = await ask("serpapi", "sp-k", reply)
    expect([req.method, req.path]).toEqual(["GET", "/search"])
    expect(req.query).toEqual({ engine: "google", output: "json", q: "latest go", api_key: "sp-k" })
    expect(pages).toEqual([page("S", "https://s.example/1", "ss", "2026-09-01"), page("x", "https://s.example/2", "")])
  })

  test("serpapi: a refusal that echoes its address is said with the key masked", async () => {
    const key = "sp-secret-123456"
    const err = await fail("serpapi", key, () => new Response(JSON.stringify({ error: `api_key=${key} is invalid` }), { status: 401 }))
    expect(err).toBeInstanceOf(Refused)
    expect(err.status).toBe(401)
    expect(err.message).toContain("invalid")
    expect(err.message).not.toContain(key)
    expect(restFor("serpapi", err.status, "").why).toBe("turned away")
  })

  test("serper: POST with its key in a header, organic read", async () => {
    const reply = { organic: [{ title: "Se", link: "https://se.example/1", snippet: "ses", date: "2026-10-01" }] }
    const { req, pages } = await ask("serper", "se-k", reply)
    expect([req.method, req.path, req.headers["X-API-KEY"]]).toEqual(["POST", "/search", "se-k"])
    expect(req.body).toEqual({ q: "latest go", num: 6 })
    expect(pages).toEqual([page("Se", "https://se.example/1", "ses", "2026-10-01")])
  })

  test("serper: a message it sends with 200 is a plain error", async () => {
    const err = await fail("serper", "se-k", { message: "Unauthorized", statusCode: 403 })
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("Unauthorized")
  })

  test("stepfun: its search, a snippet else its content", async () => {
    const reply = { results: [
      { title: "St", url: "https://st.example/1", snippet: "sts", time: "2026-11-01" },
      { title: "Su", url: "https://st.example/2", content: "full text" },
    ] }
    const { req, pages } = await ask("stepfun", "sf-k", reply)
    expect([req.path, req.headers.Authorization]).toEqual(["/v1/search", "Bearer sf-k"])
    expect(req.body).toEqual({ query: "latest go", n: 6 })
    expect(pages.map((p) => p.text)).toEqual(["sts", "full text"])
  })

  test("zai: its prime search, search_result read", async () => {
    const reply = { code: 200, search_result: [{ title: "Z", link: "https://z.example/1", content: "zc", publish_date: "2026-01-09" }] }
    const { req, pages } = await ask("zai", "za-k", reply)
    expect([req.url.split("?")[0], req.headers.Authorization]).toEqual(["https://api.z.ai/api/paas/v4/web_search", "Bearer za-k"])
    expect(req.body).toEqual({ search_query: "latest go", search_engine: "search-prime", count: 6 })
    expect(pages).toEqual([page("Z", "https://z.example/1", "zc", "2026-01-09")])
  })

  test("zhipu: its Chinese search, a query held to 70 characters", async () => {
    const { req, pages } = await ask("zhipu", "zp-k", { code: 0, search_result: [] }, { q: "汉".repeat(80) })
    expect([req.url.split("?")[0], req.headers.Authorization]).toEqual(["https://open.bigmodel.cn/api/paas/v4/web_search", "Bearer zp-k"])
    expect(req.body).toEqual({ search_query: "汉".repeat(70), search_engine: "search_std", search_intent: false, count: 6 })
    expect(pages).toEqual([])
  })

  test("zhipu: an error code it sends with 200 is a plain error", async () => {
    const err = await fail("zhipu", "zp-k", { code: 1211, message: "unsupported" })
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("1211")
  })

  test("search1api: its search, the key a bearer, results read", async () => {
    const reply = { results: [
      { title: "S1", link: "https://s1.example/1", snippet: "snip", published_date: "2026-01-01" },
      { title: "bad", link: "/relative" },
    ] }
    const { req, pages } = await ask("search1api", "s1-k", reply, { q: " latest go ", n: 60 })
    expect([req.method, req.path, req.headers.Authorization]).toEqual(["POST", "/search", "Bearer s1-k"])
    expect(req.body).toEqual({ query: "latest go", search_service: "google", max_results: 50, crawl_results: 0 })
    expect(pages).toEqual([page("S1", "https://s1.example/1", "snip", "2026-01-01")])
  })

  test("search1api: a refusal keeps its status and Retry-After, never its body", async () => {
    const key = "s1-secret-key-9876"
    const body = `key ${key} is out of credit; see the billing portal`
    const err = await fail("search1api", key, () => new Response(body, { status: 429, headers: { "retry-after": "7" } }))
    expect(err).toBeInstanceOf(Refused)
    expect(err.status).toBe(429)
    expect(err.retryAfter).toBe("7")
    expect(err.message).toContain("429")
    expect(err.message).not.toContain(key)
    expect(err.message).not.toContain("billing portal")
  })
})

describe("what every one of them leaves out or keeps", () => {
  test("a hit with no address to open is left out, and a search that found nothing is no pages", async () => {
    const bad = ["", "/relative", "mailto:a@example.com", "javascript:alert(1)", "https://user:pw@example.com/1", 42]
    for (const [vendor, wrap] of [
      ["anysearch", (rows) => ({ code: 0, data: { results: rows } })],
      ["serper", (rows) => ({ organic: rows })],
      ["search1api", (rows) => ({ results: rows.map((url) => ({ title: "t", link: url })) })],
    ]) {
      const { pages } = await ask(vendor, "k", wrap(bad.map((url) => ({ title: "t", url, link: url }))))
      expect([vendor, pages]).toEqual([vendor, []])
    }
  })

  test("a reply with no list of hits can't be read", async () => {
    const err = await fail("serper", "se-k", { organic: "not a list" })
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("no organic in it")
  })

  test("a reply that isn't an object can't be read either", async () => {
    const err = await fail("search1api", "s1-k", "null")
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("not an object")
  })

  test("a redirect isn't followed: the key would go where it wasn't set", async () => {
    const err = await fail("bocha", "bo-k", () => new Response("", { status: 302, headers: { location: "https://elsewhere.example" } }))
    expect(err.message).toContain("another address")
  })

  test("an address given with the API's path is that base", async () => {
    expect(baseOf(src("kagi", "k", "https://relay.example/kagi/api/v1/search/"))).toBe("https://relay.example/kagi")
    expect(baseOf(src("zhipu", "k", "https://relay.example/big/api/paas/v4/web_search"))).toBe("https://relay.example/big")
    expect(baseOf(src("moonshot-cn", "k", "https://relay.example/mcn/v1/tools/search"))).toBe("https://relay.example/mcn")
    const { req } = await ask("search1api", "k", { results: [] }, { url: "https://relay.example/s1/search" })
    expect([req.url.split("?")[0], req.path]).toEqual(["https://relay.example/s1/search", "/s1/search"])
  })

  test("every vendor here takes its own request, from an https base and its own path", () => {
    expect(Object.keys(REST).length).toBe(18)
    for (const [id, v] of Object.entries(REST)) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(typeof v.name).toBe("string")
      expect(typeof v.execute).toBe("function")
      expect(v.request).toBeUndefined()
      expect(v.base.startsWith("https://")).toBe(true)
      expect(v.base.endsWith("/")).toBe(false)
      expect(v.paths.length).toBeGreaterThan(0)
    }
  })
})
