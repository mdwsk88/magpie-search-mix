import { afterEach, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { ConfigError } from "../src/config.js"
import { resetState } from "../src/mix.js"
import { VENDORS, VERSION } from "../src/vendors.js"

const root = join(import.meta.dir, "..")
const realFetch = globalThis.fetch
const realRandom = Math.random
afterEach(() => {
  globalThis.fetch = realFetch
  Math.random = realRandom
  resetState()
})

test("the entry exports one function, the plugin: magpie calls every function it exports", async () => {
  const mod = await import("../index.js")
  expect(Object.values(mod).filter((v) => typeof v === "function").length).toBe(1)
})

test("its search API is named magpie-search-mix, needs its key field, and links how to write it", async () => {
  const { SearchMix } = await import("../index.js")
  const mix = (await SearchMix({}, {})).search.mix
  expect(mix.name).toBe("magpie-search-mix")
  expect(mix.keyOptional).toBe(false)
  expect(mix.keysURL).toMatch(/^https:\/\//)
})

test("a search reads its sources from the key field it is handed", async () => {
  const { SearchMix } = await import("../index.js")
  const mix = (await SearchMix({}, { width: 2 })).search.mix
  const asked = []
  globalThis.fetch = async (url, init) => {
    asked.push(url)
    if (url.includes("deepseek")) return new Response(JSON.stringify({ results: [{ title: "D1", url: "https://d.example/1" }, { title: "D2", url: "https://d.example/2" }] }))
    return new Response(JSON.stringify({ results: { web: [{ title: "Y1", url: "https://y.example/1" }, { title: "Y2", url: "https://y.example/2" }] } }))
  }
  const got = await mix.execute({ query: "q", count: 6, key: "deepseek=sk-z+you", url: "" }, { abort: AbortSignal.timeout(5000) })
  expect(got.map((p) => p.title)).toEqual(["D1", "Y1", "D2", "Y2"])
  expect(asked.length).toBe(2)
})

test('{"width": 1, "order": "random"} asks one source at random for each search; without "order" they are asked as listed', async () => {
  const { SearchMix } = await import("../index.js")
  const asked = []
  globalThis.fetch = async (url) => {
    const d = url.includes("deepseek")
    asked.push(d ? "deepseek" : "you")
    return new Response(JSON.stringify(d ? { results: [{ title: "D1", url: "https://d.example/1" }] } : { results: { web: [{ title: "Y1", url: "https://y.example/1" }] } }))
  }
  const search = async (options) => (await SearchMix({}, options)).search.mix.execute({ query: "q", count: 6, key: "deepseek=sk-z+you" }, { abort: AbortSignal.timeout(5000) })
  // shuffled with 0, [deepseek, you] comes out [you, deepseek]; with 0.9 it stays
  Math.random = () => 0
  await search({ width: 1 })
  await search({ width: 1, order: "random" })
  Math.random = () => 0.9
  await search({ width: 1, order: "random" })
  expect(asked).toEqual(["deepseek", "you", "deepseek"])
})

test("a key field that can't be read is a plain error: magpie asks its next search API and doesn't rest the field", async () => {
  const { SearchMix } = await import("../index.js")
  const mix = (await SearchMix({}, {})).search.mix
  const err = await mix.execute({ query: "q", count: 6, key: "bing=k" }, { abort: AbortSignal.timeout(5000) }).catch((e) => e)
  expect(err).toBeInstanceOf(ConfigError)
  expect(err.status).toBeUndefined()
})

// magpie's own split of a key field (provider.SearchAPI.Keys): each part is
// one key, handed to the plugin one per search
const magpieKeys = (field) => field.split(/[,; \t\n\r]+/).filter(Boolean)

test("sources split by a space reach it one at a time in magpie: it says so instead of searching with one", async () => {
  const { SearchMix } = await import("../index.js")
  const mix = (await SearchMix({}, {})).search.mix
  const parts = magpieKeys("you tavily=tvly-k")
  expect(parts).toEqual(["you", "tavily=tvly-k"])
  for (const key of parts) {
    const err = await mix.execute({ query: "q", count: 6, key }, { abort: AbortSignal.timeout(5000) }).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.message).toContain('join sources with "+"')
    expect(err.message).not.toContain("tvly-k")
  }
  expect(magpieKeys("you+tavily=tvly-k")).toEqual(["you+tavily=tvly-k"])
})

test("it reads no file of magpie's: its sources and keys come only from its key field", () => {
  const files = ["index.js", ...readdirSync(join(root, "src")).map((f) => join("src", f))]
  for (const f of files) {
    const s = readFileSync(join(root, f), "utf8")
    expect(s).not.toContain("providers.json")
    expect(s).not.toContain("readFile")
    expect(s).not.toContain(".config/magpie")
  }
})

test("its version is the package's", () => {
  expect(VERSION).toBe(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version)
})

// How wide a text is on its plugin card in magpie, in Chinese characters, as
// measured on the card in issue #3's screenshot: a line holds 25 Chinese
// characters; a small Latin letter is 0.5 of one, a space 0.3, a capital,
// digit or mark 0.65. The card shows two lines of the summary, then "…".
const cardWidth = (text) => [...text].reduce((w, c) => w + (c.codePointAt(0) >= 0x2e80 ? 1 : c === " " ? 0.3 : c >= "a" && c <= "z" ? 0.5 : 0.65), 0)
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

test("its summary fits the two lines of its card in magpie, in each language, and so does its description", () => {
  const texts = { ...pkg.magpie.summary, description: pkg.description }
  // two lines of 25, less 5 for a word that wraps to the second line early
  const tooWide = Object.entries(texts).filter(([, t]) => cardWidth(t) > 45).map(([k, t]) => `${k}: ${cardWidth(t).toFixed(1)}`)
  expect(tooWide).toEqual([])
})

test("its summary names the same search APIs in each language", () => {
  const named = (text) => Object.values(VENDORS).map((v) => v.name.split(" ")[0]).filter((n) => text.includes(n))
  expect(named(pkg.magpie.summary.zh)).toEqual(named(pkg.magpie.summary.en))
})
