import { describe, expect, test } from "bun:test"
import { ConfigError, parseSources } from "../src/config.js"

describe("the key field", () => {
  test("reads sources in their order, joined by +", () => {
    const got = parseSources("deepseek=sk-1+you+tavily=tvly-a|tvly-b+searxng@https://searx.example.com/")
    expect(got.map((s) => s.vendor)).toEqual(["deepseek", "you", "tavily", "searxng"])
    expect(got[0].keys).toEqual(["sk-1"])
    expect(got[1].keys).toEqual([])
    expect(got[2].keys).toEqual(["tvly-a", "tvly-b"])
    expect(got[3].url).toBe("https://searx.example.com")
    expect(got[2].name).toBe("Tavily")
  })

  test("a key may hold '=' and an address may follow it", () => {
    const [s] = parseSources("tavily=abc==@https://relay.example/tavily")
    expect(s.keys).toEqual(["abc=="])
    expect(s.url).toBe("https://relay.example/tavily")
  })

  test("the same API twice is two sources, told apart", () => {
    const got = parseSources("searxng@https://a.example+searxng@https://b.example")
    expect(got.map((s) => s.label)).toEqual(["searxng", "searxng#2"])
  })

  test("API names are read in any case", () => {
    expect(parseSources("YOU")[0].vendor).toBe("you")
  })

  test("says what is wrong, by place, never a key", () => {
    let err
    try {
      parseSources("bing=k1+tavily+searxng+you@ftp://x.example+deepseek=sk-secret@https://x.example/?a=1")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.status).toBeUndefined()
    expect(err.message).toContain('source 1: no search API "bing"')
    expect(err.message).toContain("source 2: tavily needs its key")
    expect(err.message).toContain("source 3: searxng needs its address")
    expect(err.message).toContain("source 4 (you): its address isn't an http:// or https:// URL")
    expect(err.message).toContain("source 5 (deepseek): give its base URL alone")
    expect(err.message).not.toContain("sk-secret")
    expect(err.message).not.toContain("k1")
  })

  test("an empty field says how to write one", () => {
    expect(() => parseSources("  ")).toThrow(/join sources with "\+"/)
  })

  test("spaces, semicolons and commas are read as + too (scripts/try.js); in magpie they never reach it", () => {
    expect(parseSources("you tavily=k;brave=b,exa=e").map((s) => s.vendor)).toEqual(["you", "tavily", "brave", "exa"])
  })
})
