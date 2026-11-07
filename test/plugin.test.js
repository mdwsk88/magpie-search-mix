import { afterEach, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { ConfigError } from "../src/config.js"
import { resetState } from "../src/mix.js"
import { VERSION } from "../src/vendors.js"

const root = join(import.meta.dir, "..")
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
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
