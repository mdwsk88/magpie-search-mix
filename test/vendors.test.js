// Each search API is asked, and its reply read, as magpie asks and reads
// it. The replies and what is expected of them are magpie's own tests'
// (yetone/magpie internal/gateway/search_api_test.go and testdata/).

import { beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Refused, askSource, resetState, restFor } from "../src/mix.js"
import { USER_AGENT, VENDORS, baseOf, plain, wsaCntFor } from "../src/vendors.js"

const fixture = (f) => readFileSync(join(import.meta.dir, "fixtures", f), "utf8")
const src = (vendor, key = "", url = `https://fake.example/${vendor}`) => ({ vendor, name: VENDORS[vendor].name, keys: key ? [key] : [], url, label: vendor })

// fake answers every request with what reply(req) says, and keeps the requests
function fake(reply) {
  const asked = []
  const f = async (url, init) => {
    const u = new URL(url)
    const req = { url, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect }
    asked.push(req)
    const r = reply(req)
    return r instanceof Response ? r : new Response(typeof r === "string" ? r : JSON.stringify(r), { status: 200 })
  }
  f.asked = asked
  return f
}

beforeEach(() => resetState())

describe("each API asked its own way (magpie's TestSearchAPIsEachAsked)", () => {
  const replies = {
    tavily: '{"query":"x","results":[{"title":"Go downloads","url":"https://go.dev/dl/","content":"go1.27.1 is the latest release.","score":0.9}]}',
    brave: '{"type":"search","web":{"results":[{"title":"Go &amp; <strong>downloads</strong>","url":"https://go.dev/dl/","description":"The <strong>latest</strong> Go is 1.27.1"}]}}',
    exa: '{"results":[{"title":"Go downloads","url":"https://go.dev/dl/","text":"Go 1.27.1 was released."}]}',
    firecrawl: '{"success":true,"data":{"web":[{"title":"Go downloads","url":"https://go.dev/dl/","description":"Download Go 1.27.1"}]}}',
    searxng: '{"query":"x","results":[{"title":"Go downloads","url":"https://go.dev/dl/","content":"Go 1.27.1 is out"},{"title":"","url":""}]}',
  }
  const cases = [
    ["tavily", "tvly-k", "POST", "/tavily/search", (r) => r.headers.Authorization === "Bearer tvly-k", "go1.27.1 is the latest release."],
    ["brave", "brave-k", "GET", "/brave/res/v1/web/search", (r) => r.headers["X-Subscription-Token"] === "brave-k" && r.query.q === "latest go" && r.query.count === "6", "The latest Go is 1.27.1"],
    ["exa", "exa-k", "POST", "/exa/search", (r) => r.headers["X-API-Key"] === "exa-k" && r.body.numResults === 6 && r.body.contents.text.maxCharacters === 1500, "Go 1.27.1 was released."],
    ["firecrawl", "fc-k", "POST", "/firecrawl/v2/search", (r) => r.headers.Authorization === "Bearer fc-k" && r.body.limit === 6, "Download Go 1.27.1"],
    ["searxng", "", "GET", "/searxng/search", (r) => r.query.format === "json" && r.query.q === "latest go" && !r.headers.Authorization, "Go 1.27.1 is out"],
  ]
  for (const [vendor, key, method, path, keyed, text] of cases) {
    test(vendor, async () => {
      const f = fake(() => replies[vendor])
      const pages = await askSource(src(vendor, key), "latest go", 6, undefined, f)
      const [r] = f.asked
      expect([r.method, r.path]).toEqual([method, path])
      expect(keyed(r)).toBe(true)
      expect(r.headers["User-Agent"]).toBe(USER_AGENT)
      expect(r.redirect).toBe("manual")
      expect(pages.length).toBe(1)
      expect(pages[0].url).toBe("https://go.dev/dl/")
      expect(pages[0].text).toBe(text)
      expect(pages[0].title.startsWith("Go ")).toBe(true)
    })
  }

  test("Brave's title loses its tags and entities", async () => {
    const pages = await askSource(src("brave", "brave-k"), "q", 6, undefined, fake(() => replies.brave))
    expect(pages[0].title).toBe("Go & downloads")
  })

  test("a refused key is said, its key masked", async () => {
    const f = fake((r) => new Response(`{"error":"bad key ${r.headers["X-API-Key"]}"}`, { status: 401 }))
    const err = await askSource(src("exa", "exa-wrong-key-1234"), "q", 6, undefined, f).catch((e) => e)
    expect(err).toBeInstanceOf(Refused)
    expect(err.status).toBe(401)
    expect(err.message).toContain("bad key")
    expect(err.message).not.toContain("exa-wrong-key-1234")
  })

  test("Firecrawl's v1 reply, data as a list, is read too", async () => {
    const pages = await askSource(src("firecrawl", "fc-k"), "q", 6, undefined, fake(() => ({ success: true, data: [{ title: "T", url: "https://a.example", markdown: "m" }] })))
    expect(pages[0].text).toBe("m")
  })
})

describe("DeepSeek (magpie's TestDeepSeekSearchAPI)", () => {
  test("gets at most 128 characters, its summary is the text", async () => {
    const f = fake(() => ({ results: [{ title: "A", url: "https://a.example", summary: "long summary", snippet: "short", date: "2026-11-01T00:00:00Z" }, { title: "B", url: "", summary: "x" }] }))
    const pages = await askSource(src("deepseek", "sk-k", ""), "汉".repeat(200), 6, undefined, f)
    const [r] = f.asked
    expect(r.url).toBe("https://api.deepseek.com/v1/tools/search")
    expect(r.headers.Authorization).toBe("Bearer sk-k")
    expect([...r.body.query].length).toBe(128)
    expect(r.body.count).toBe(6)
    expect(pages).toEqual([{ title: "A", url: "https://a.example", text: "long summary", age: "2026-11-01T00:00:00Z" }])
  })
})

describe("You.com", () => {
  test("free: GET of its agents search, with no key and no one else's tag", async () => {
    const f = fake(() => ({ results: { web: [{ title: "Y", url: "https://y.example", snippets: ["a", "b"], description: "d", page_age: "2026-11-01" }], news: [{ title: "N", url: "https://n.example", description: "news" }] } }))
    const pages = await askSource(src("you", "", ""), "a b", 6, undefined, f)
    expect(f.asked[0].url).toBe("https://api.you.com/v1/agents/search?query=a+b&count=6")
    expect(f.asked[0].headers["X-API-Key"]).toBeUndefined()
    expect(f.asked[0].headers["User-Agent"]).toBe(USER_AGENT)
    expect(pages.map((p) => [p.title, p.text, p.age])).toEqual([["Y", "a b", "2026-11-01"], ["N", "news", ""]])
  })

  test("with a key: POST to its search API; with an address and no key: that address's agents search", async () => {
    const f = fake(() => ({ results: { web: [] } }))
    await askSource(src("you", "ydc-k", ""), "q", 4, undefined, f)
    expect([f.asked[0].method, f.asked[0].url, f.asked[0].headers["X-API-Key"], f.asked[0].body.count]).toEqual(["POST", "https://ydc-index.io/v1/search", "ydc-k", 4])
    await askSource(src("you", "", "https://you.example/v1/agents/search"), "q", 4, undefined, f)
    expect(f.asked[1].url).toBe("https://you.example/v1/agents/search?query=q&count=4")
  })

  test("its error's words are its message", async () => {
    const f = fake(() => new Response('{"code":"payment_required","message":"Free searches used up for today"}', { status: 402 }))
    const err = await askSource(src("you", "", ""), "q", 6, undefined, f).catch((e) => e)
    expect(err.status).toBe(402)
    expect(err.message).toContain("Free searches used up for today")
  })

  test("a reply with no results is a failure, not nothing found", async () => {
    const err = await askSource(src("you", "", ""), "q", 6, undefined, fake(() => ({}))).catch((e) => e)
    expect(err.message).toContain("no results in it")
  })
})

describe("Doubao Search, Volcengine (magpie's TestVolcengineSearchAPI)", () => {
  const key = "volc-key-123456"
  test("asked as its docs say, its Summary the text", async () => {
    const f = fake(() => fixture("volcengine_web_search.json"))
    for (const q of ["北京最新游玩攻略", "搜".repeat(150)]) {
      const pages = await askSource(src("volcengine", key), q, 6, undefined, f)
      expect(pages.length).toBe(2)
      expect(pages[0].url).toBe("https://c.m.163.com/news/a/L4U501RM0556LJ9Q.html")
      expect(pages[0].title).toBe("2026北京5日游超全攻略｜行前预约、交通住宿、经典路线、避坑指南一站式拆解")
      expect(pages[0].text.startsWith("2026北京5日游超全攻略｜行前预约、交通住宿、经典路线、避坑指南一站式拆解 北京旅游——行前准备")).toBe(true)
      expect(pages[0].text).toContain("高铁（首选）")
      expect(pages[0].text).not.toContain("旅游定制小团 2026-08-22")
      expect(pages[0].age).toBe("2026-08-22T09:16:00+08:00")
      expect([...pages[0].text].length).toBeLessThanOrEqual(1501)
      expect([pages[1].url, pages[1].age]).toEqual(["https://www.cnblogs.com/chun-wan-lv/p/22651954", "2026-08-24T11:37:00+08:00"])
    }
    expect([f.asked[0].method, f.asked[0].path, f.asked[0].headers["Content-Type"], f.asked[0].headers.Authorization]).toEqual(["POST", "/volcengine/search_api/web_search", "application/json", `Bearer ${key}`])
    expect(f.asked[0].body).toEqual({ Count: 6, Filter: { NeedUrl: true }, Query: "北京最新游玩攻略", SearchType: "web" })
    expect(f.asked[1].body.Query).toBe("搜".repeat(100))
  })

  test("a page with no URL is left out, and a 1970 time is none", async () => {
    const f = fake(() =>
      '{"ResponseMetadata":{"RequestId":"r"},"Result":{"ResultCount":2,"WebResults":[' +
      '{"Id":"a","SortId":1,"Title":"天气","SiteName":"火山如意","Url":"","Snippet":"晴"},' +
      '{"Id":"b","SortId":2,"Title":"<em>Go</em> 下载","Url":"https://go.dev/dl/","Snippet":"Download Go.","Summary":"","PublishTime":"1970-01-01T08:00:00+08:00"}]}}')
    const pages = await askSource(src("volcengine", key), "go", 6, undefined, f)
    expect(pages).toEqual([{ title: "Go 下载", url: "https://go.dev/dl/", text: "Download Go.", age: "" }])
  })

  const errReply = (code, msg) => JSON.stringify({ ResponseMetadata: { RequestId: "r", Action: "WebSearch", Error: { CodeN: code, Code: String(code), Message: msg } }, Result: null })
  for (const [status, code, want, why] of [
    [200, 10403, 403, "turned away"], [401, 10401, 403, "turned away"], [200, 10406, 402, "out of credit"], [200, 10412, 402, "out of credit"],
    [429, 700429, 429, "rate limited"], [200, 700429, 429, "rate limited"], [200, 10400, 0, ""], [500, 10500, 0, ""],
  ]) {
    test(`its error ${code} with ${status}`, async () => {
      const f = fake(() => new Response(errReply(code, `${key} query or search type is empty`), { status }))
      const err = await askSource(src("volcengine", key), "q", 6, undefined, f).catch((e) => e)
      expect(err.message).toContain(`${code} `)
      expect(err.message).not.toContain(key)
      expect(err instanceof Refused).toBe(want !== 0)
      if (want) {
        expect(err.status).toBe(want)
        expect(restFor("volcengine", err.status, "").why).toBe(why)
      }
    })
  }
})

describe("Yuanbao Search, Tencent Cloud (magpie's TestWSASearchAPI)", () => {
  const key = "sk-209b0123456789e23d"
  test("its API-key page's example reply", async () => {
    const f = fake(() => fixture("wsa_searchpro_apikey.json"))
    const pages = await askSource(src("wsa", key), "三星堆的由来", 6, undefined, f)
    expect(pages.length).toBe(3)
    expect(pages[0].url).toBe("https://www.163.com/dy/article/J43Q2STU0553FV3Z.html")
    expect(pages[0].title).toBe("三星堆名字的由来,你真的了解吗?三星堆的参观攻略,建议收藏青铜文物玉器古蜀国三星堆遗址_网易订阅")
    expect(pages[0].text.startsWith("三星堆名字的由来 三星堆遗址位于四川省广汉市西北部")).toBe(true)
    expect(pages[0].age).toBe("2024-06-07 19:00:51")
    expect(pages[1].url).toBe("https://news.qq.com/rain/a/20240903A048N700")
    expect(pages[2].text).toBe("最早在1929年,一位当地农民在遗址区域内偶然发现了一个玉器坑,这一发现引起了考古界的关注｡在四川省广汉市西北部,有三座稍稍隆起的土堆呈直线排列,这种地形布局与夜空中闪烁的三颗星辰相呼应,因此得名“三星堆”｡")
    expect([f.asked[0].method, f.asked[0].path, f.asked[0].headers.Authorization]).toEqual(["POST", "/wsa/SearchPro", `Bearer ${key}`])
    expect(f.asked[0].body).toEqual({ Query: "三星堆的由来", Cnt: 10 })
  })

  test("its API page's example reply: a passage that is only its title gives way to its content", async () => {
    const pages = await askSource(src("wsa", key), "人工智能发展现状", 6, undefined, fake(() => fixture("wsa_searchpro.json")))
    expect(pages).toEqual([{
      title: "【新思想引领新征程】人工智能创新加速我国产业转型升级_中央网络安全和信息化委员会办公室",
      url: "https://www.cac.gov.cn/2025-02/26/c_1742272852299173.htm",
      text: "【新思想引领新征程】人工智能创新加速我国产业转型升级_中央网络安全和信息化委员会办公室...",
      age: "2025/02/26 09:37:00",
    }])
  })

  const errReply = (code, msg) => JSON.stringify({ Response: { Error: { Code: code, Message: msg }, RequestId: "ed93f3cb" } })
  for (const [code, msg, want, why] of [
    ["UnauthorizedOperation", "未授权操作。", 403, "turned away"],
    ["AuthFailure.SignatureFailure", "The provided credentials could not be validated.", 403, "turned away"],
    ["ResourceNotFound", "用户资源未开通。", 403, "turned away"],
    ["ResourceUnavailable", "用户资源不可用。", 402, "out of credit"],
    ["LimitExceeded", "超过配额限制。", 402, "out of credit"],
    ["RequestLimitExceeded", "请求的次数超过了频率限制。", 429, "rate limited"],
    ["RequestLimitExceeded.UinLimitExceeded", "主账号限频。", 429, "rate limited"],
    ["InvalidParameter", `illegal Cnt ${key}`, 0, ""],
    ["InternalError", "内部错误。", 0, ""],
  ]) {
    test(`its error ${code}`, async () => {
      const err = await askSource(src("wsa", key), "q", 6, undefined, fake(() => errReply(code, msg))).catch((e) => e)
      expect(err.message).toContain(`${code} `)
      expect(err.message).not.toContain(key)
      expect(err instanceof Refused).toBe(want !== 0)
      if (want) {
        expect(err.status).toBe(want)
        expect(restFor("wsa", err.status, "").why).toBe(why)
      }
    })
  }

  test("Cnt is the fewest of 10/20/30/40/50 that covers n", () => {
    expect([1, 6, 10, 11, 20, 21, 60].map(wsaCntFor)).toEqual([10, 10, 10, 20, 20, 30, 50])
  })
})

describe("addresses and text", () => {
  test("a base URL given with the API's path is that base", () => {
    expect(baseOf(src("tavily", "k", "https://relay.example/tavily/search/"))).toBe("https://relay.example/tavily")
    expect(baseOf(src("deepseek", "k", ""))).toBe("https://api.deepseek.com")
  })

  test("a redirect isn't followed: the key would go where it wasn't set", async () => {
    const f = fake(() => new Response("", { status: 302, headers: { location: "https://elsewhere.example" } }))
    await expect(askSource(src("tavily", "k"), "q", 6, undefined, f)).rejects.toThrow(/another address/)
    expect(f.asked.length).toBe(1)
  })

  test("plain drops tags, decodes entities and folds white space", () => {
    expect(plain("  <b>A</b> &amp;\n B &#x4e2d;&#25991; &bogus; ")).toBe("A & B 中文 &bogus;")
  })

  test("every vendor has a name, a base or needs an address, and how to ask and read it", () => {
    for (const [id, v] of Object.entries(VENDORS)) {
      expect(typeof v.name).toBe("string")
      expect(Boolean(v.base) || v.needsURL === true).toBe(true)
      expect(typeof v.request).toBe("function")
      expect(typeof v.pages).toBe("function")
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })
})
