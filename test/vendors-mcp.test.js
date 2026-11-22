import { beforeEach, describe, expect, test } from "bun:test"
import { Refused, askSource, keysInTurn, resetState } from "../src/mix.js"
import { extractMCPResults } from "../src/mcp.js"
import { USER_AGENT, VENDORS, VERSION, baseOf } from "../src/vendors.js"

const src = (vendor, key = "", url = "") => ({
  vendor,
  name: VENDORS[vendor].name,
  keys: Array.isArray(key) ? key : key ? [key] : [],
  url,
  label: vendor,
})

const page = (title, url, text, age = "") => ({ title, url, text, age })

function fake(reply) {
  const asked = []
  const f = async (url, init) => {
    const u = new URL(url)
    const req = {
      url,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
      signal: init.signal,
    }
    asked.push(req)
    const r = typeof reply === "function" ? reply(req) : reply
    return r instanceof Response ? r.clone() : new Response(typeof r === "string" ? r : JSON.stringify(r), { status: 200 })
  }
  f.asked = asked
  return f
}

const rpc = (id, result) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } })

const sse = (...messages) =>
  new Response(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

async function ask(vendor, key, reply, options = {}) {
  const { url = "", q = "latest go", n = 6 } = options
  const f = fake(reply)
  const pages = await askSource(src(vendor, key, url), q, n, undefined, f)
  return { asked: f.asked, pages }
}

const fail = (vendor, key, reply, options) => ask(vendor, key, reply, options).catch((e) => e)

function session(handlers) {
  const asked = []
  const f = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    asked.push({ url, method: init.method, headers: init.headers, body, redirect: init.redirect, signal: init.signal })
    if (init.method === "DELETE") return new Response(null, { status: 204 })
    const handle = handlers[body.method]
    if (!handle) return new Response("", { status: 500 })
    return handle(body, init)
  }
  f.asked = asked
  return f
}

const handshake = ({ sid = "sess-abc-123", protocol = "2025-06-18", tools = [] } = {}) => ({
  initialize: (body) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: protocol, capabilities: {}, serverInfo: { name: "stub" } } }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": sid },
    }),
  "notifications/initialized": () => new Response(null, { status: 202 }),
  "tools/list": (body) => rpc(body.id, { tools }),
})

const searchTool = (name = "web_search_prime", properties = { search_query: { type: "string" }, count: { type: "number" } }) => ({
  name,
  inputSchema: { type: "object", properties },
})

beforeEach(() => resetState())

describe("the MCP sources", () => {
  test("parallel: no key asks its stateless MCP search, JSON read", async () => {
    const reply = rpc(1, {
      structuredContent: {
        results: [
          { title: "P", url: "https://p.example/1", excerpts: ["first", "second"], publish_date: "2026-01-01" },
          { title: "bad", url: "javascript:alert(1)", excerpts: ["x"] },
        ],
      },
    })
    const { asked, pages } = await ask("parallel", "", () => reply)
    const req = asked[0]
    expect([req.method, req.url, req.redirect]).toEqual(["POST", "https://mcp.parallel.ai/mcp", "manual"])
    expect([req.headers.Accept, req.headers["Content-Type"], req.headers["User-Agent"]]).toEqual([
      "application/json, text/event-stream",
      "application/json",
      USER_AGENT,
    ])
    expect(req.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_search", arguments: { objective: "latest go", search_queries: ["latest go"] } },
    })
    expect(pages).toEqual([page("P", "https://p.example/1", "first second", "2026-01-01")])
  })

  test("parallel: a key asks its REST search, excerpts joined", async () => {
    const reply = { results: [{ title: "P", url: "https://p.example/1", excerpts: ["a", "b"], publish_date: "2026-01-02" }] }
    const { asked, pages } = await ask("parallel", "pk-one-1234", reply)
    const req = asked[0]
    expect([req.method, req.path, req.headers["x-api-key"], req.redirect]).toEqual(["POST", "/v1/search", "pk-one-1234", "manual"])
    expect(req.url).toBe("https://api.parallel.ai/v1/search")
    expect(req.body).toEqual({
      objective: "latest go",
      search_queries: ["latest go"],
      mode: "fast",
      advanced_settings: { max_results: 6, excerpt_settings: { max_chars_per_result: 4000 } },
    })
    expect(pages).toEqual([page("P", "https://p.example/1", "a b", "2026-01-02")])
  })

  test("parallel: an address given with either path is that base", () => {
    expect(baseOf(src("parallel", "", "https://relay.example/p/mcp"))).toBe("https://relay.example/p")
    expect(baseOf(src("parallel", "k", "https://relay.example/p/v1/search"))).toBe("https://relay.example/p")
  })

  test("parallel: a custom address is used for both modes", async () => {
    const anon = await ask("parallel", "", () => rpc(1, { structuredContent: { results: [] } }), { url: "https://relay.example/p/mcp" })
    expect(anon.asked[0].url).toBe("https://relay.example/p/mcp")
    const keyed = await ask("parallel", "pk-1234", { results: [] }, { url: "https://relay.example/p/v1/search" })
    expect(keyed.asked[0].url).toBe("https://relay.example/p/v1/search")
  })

  test("tinyfish: no key asks its stateless MCP search with the keyless header, SSE read", async () => {
    const reply = sse(
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } },
      { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "T", url: "https://t.example/1", snippet: "ts", date: "2026-02-01" }] }) }] } },
    )
    const { asked, pages } = await ask("tinyfish", "", () => reply)
    const req = asked[0]
    expect([req.method, req.url, req.headers["X-TinyFish-Access-Mode"], req.redirect]).toEqual(["POST", "https://agent.tinyfish.ai/mcp", "keyless", "manual"])
    expect(req.body.params).toEqual({ name: "search", arguments: { query: "latest go", domain_type: "web" } })
    expect(pages).toEqual([page("T", "https://t.example/1", "ts", "2026-02-01")])
  })

  test("tinyfish: a key asks its REST search at the root", async () => {
    const reply = { results: [{ title: "T", url: "https://t.example/1", snippet: "ts", date: "2026-02-02" }] }
    const { asked, pages } = await ask("tinyfish", "tf-one-1234", reply)
    const req = asked[0]
    expect([req.method, req.url, req.headers["X-API-Key"]]).toEqual([
      "GET",
      "https://api.search.tinyfish.ai/?query=latest+go&domain_type=web",
      "tf-one-1234",
    ])
    expect(req.query).toEqual({ query: "latest go", domain_type: "web" })
    expect(pages).toEqual([page("T", "https://t.example/1", "ts", "2026-02-02")])
  })

  test("tinyfish: an address given with /mcp is that base", async () => {
    expect(baseOf(src("tinyfish", "", "https://relay.example/tf/mcp"))).toBe("https://relay.example/tf")
    const anon = await ask("tinyfish", "", () => rpc(1, { structuredContent: { results: [] } }), { url: "https://relay.example/tf/mcp" })
    expect(anon.asked[0].url).toBe("https://relay.example/tf/mcp")
  })

  test("zai-coding: a session, from initialize to a cleanup", async () => {
    const f = session({
      ...handshake({ sid: "sess-zai-1234", tools: [searchTool()] }),
      "tools/call": (body) =>
        rpc(body.id, {
          structuredContent: {
            results: [
              { title: "Z", link: "https://z.example/1", content: "zc", publish_date: "2026-01-09" },
              { title: "bad", link: "mailto:someone@example.com", content: "x" },
            ],
          },
        }),
    })
    const pages = await askSource(src("zai-coding", "zc-key-1234"), "latest go", 6, undefined, f)
    const [init, ready, listed, called, closed] = f.asked
    expect(f.asked.map((c) => c.method)).toEqual(["POST", "POST", "POST", "POST", "DELETE"])
    expect(init.url).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp")
    expect([init.headers.Authorization, init.headers["Mcp-Session-Id"], init.headers["User-Agent"], init.redirect]).toEqual([
      "Bearer zc-key-1234",
      undefined,
      USER_AGENT,
      "manual",
    ])
    expect(init.body.params.protocolVersion).toBeTruthy()
    expect(init.body.params.clientInfo).toEqual({ name: "magpie-search-mix", version: VERSION })
    expect([ready.body.method, ready.headers["Mcp-Session-Id"]]).toEqual(["notifications/initialized", "sess-zai-1234"])
    expect([listed.body.method, listed.headers["Mcp-Session-Id"], listed.headers["MCP-Protocol-Version"]]).toEqual([
      "tools/list",
      "sess-zai-1234",
      "2025-06-18",
    ])
    expect(called.body.params).toEqual({ name: "web_search_prime", arguments: { search_query: "latest go", count: 6 } })
    expect([closed.method, closed.headers["Mcp-Session-Id"], closed.redirect]).toEqual(["DELETE", "sess-zai-1234", "manual"])
    expect(pages).toEqual([page("Z", "https://z.example/1", "zc", "2026-01-09")])
  })

  test("zhipu-coding: the other site, its camel-case tool, a schema without count", async () => {
    const f = session({
      ...handshake({ sid: "sess-zp-1234", tools: [searchTool("webSearchPrime", { search_query: { type: "string" } })] }),
      "tools/call": (body) =>
        rpc(body.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                search_result: [
                  { title: "Zh", url: "https://zh.example/1", snippet: "zs", publish_date: "2026-02-02" },
                  { title: "Zi", link: "", url: "https://zh.example/2", content: "", snippet: "zs2" },
                ],
              }),
            },
          ],
        }),
    })
    const pages = await askSource(src("zhipu-coding", "zp-key-1234"), "latest  go", 6, undefined, f)
    expect(f.asked[0].url).toBe("https://open.bigmodel.cn/api/mcp/web_search_prime/mcp")
    expect(f.asked[3].body.params).toEqual({ name: "webSearchPrime", arguments: { search_query: "latest go" } })
    expect(pages).toEqual([page("Zh", "https://zh.example/1", "zs", "2026-02-02"), page("Zi", "https://zh.example/2", "zs2")])
  })

  test("a coding plan: an address given with the tool's path is that base", async () => {
    const custom = "https://relay.example/zp/api/mcp/web_search_prime/mcp"
    expect(baseOf(src("zhipu-coding", "", custom))).toBe("https://relay.example/zp")
    const f = session({
      ...handshake({ sid: "sess-custom-1234", tools: [searchTool()] }),
      "tools/call": (body) => rpc(body.id, { structuredContent: { results: [{ title: "C", link: "https://c.example/1", content: "cc" }] } }),
    })
    const pages = await askSource(src("zhipu-coding", "zp-key-1234", custom), "q", 6, undefined, f)
    expect(f.asked[0].url).toBe("https://relay.example/zp/api/mcp/web_search_prime/mcp")
    expect(pages).toEqual([page("C", "https://c.example/1", "cc")])
  })

  test("a session reply read from SSE, notifications before the result", async () => {
    const f = session({
      initialize: (body) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess-sse-1234" },
        }),
      "notifications/initialized": () => new Response(null, { status: 202 }),
      "tools/list": (body) => sse({ jsonrpc: "2.0", method: "notifications/message", params: {} }, { jsonrpc: "2.0", id: body.id, result: { tools: [searchTool()] } }),
      "tools/call": (body) => sse({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { results: [{ title: "S", link: "https://s.example/1", content: "sc" }] } } }),
    })
    const pages = await askSource(src("zai-coding", "zc-key-1234"), "q", 6, undefined, f)
    expect(pages).toEqual([page("S", "https://s.example/1", "sc")])
  })
})

describe("what the MCP transport refuses", () => {
  test("a JSON-RPC error is a plain error", async () => {
    const err = await fail("parallel", "", () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad arguments" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("MCP error")
    expect(err.message).toContain("bad arguments")
  })

  test("a tool that says it failed is a plain error", async () => {
    const err = await fail("tinyfish", "", () => rpc(1, { content: [{ type: "text", text: "no" }], isError: true }))
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("search tool failed")
  })

  test("a redirect isn't followed: the key would go where it wasn't set", async () => {
    const f = fake(() => new Response("", { status: 302, headers: { location: "https://elsewhere.example" } }))
    const err = await askSource(src("parallel", ""), "q", 6, undefined, f).catch((e) => e)
    expect(err.message).toContain("another address")
    expect(f.asked.length).toBe(1)
  })

  test("a keyed REST redirect isn't followed either", async () => {
    const err = await fail("parallel", "pk-one-1234", () => new Response("", { status: 307, headers: { location: "https://elsewhere.example" } }))
    expect(err.message).toContain("another address")
    expect(err.status).toBeUndefined()
  })

  test("a session cleanup still happens when the call fails", async () => {
    const f = session({
      ...handshake({ sid: "sess-fail-1234", tools: [searchTool()] }),
      "tools/call": (body) => rpc(body.id, { content: [{ type: "text", text: "tool broke" }], isError: true }),
    })
    const err = await askSource(src("zai-coding", "zc-key-1234"), "q", 6, undefined, f).catch((e) => e)
    expect(err.message).toContain("search tool failed")
    expect(f.asked.at(-1).method).toBe("DELETE")
  })

  test("a session with no session ID can't be read", async () => {
    const f = session({
      initialize: (body) => rpc(body.id, { protocolVersion: "2025-06-18" }),
      "notifications/initialized": () => new Response(null, { status: 202 }),
      "tools/list": (body) => rpc(body.id, { tools: [searchTool()] }),
    })
    const err = await askSource(src("zai-coding", "zc-key-1234"), "q", 6, undefined, f).catch((e) => e)
    expect(err.message).toContain("missing session ID")
    expect(err.status).toBeUndefined()
    expect(f.asked.length).toBe(1)
  })

  test("a session offering no supported tool says what it offers", async () => {
    const f = session({ ...handshake({ sid: "sess-tools-1234", tools: [{ name: "something_else" }] }) })
    const err = await askSource(src("zai-coding", "zc-key-1234"), "q", 6, undefined, f).catch((e) => e)
    expect(err.message).toContain("did not publish")
    expect(err.message).toContain("something_else")
  })

  test("a session's JSON-RPC error is said, and the session closed", async () => {
    const f = session({
      ...handshake({ sid: "sess-rpc-1234", tools: [searchTool()] }),
      "tools/call": (body) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "upstream broke" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
    const err = await askSource(src("zai-coding", "zc-key-1234"), "q", 6, undefined, f).catch((e) => e)
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("MCP error")
    expect(err.message).toContain("upstream broke")
    expect(f.asked.at(-1).method).toBe("DELETE")
  })

  for (const status of [401, 402, 429]) {
    test(`${status} keeps its status and Retry-After, and the key is never said`, async () => {
      const key = "pk-secret-1234"
      const err = await fail("parallel", key, () =>
        new Response(JSON.stringify({ error: { message: `key ${key} refused` } }), {
          status,
          headers: { "retry-after": "7" },
        }),
      )
      expect(err).toBeInstanceOf(Refused)
      expect(err.status).toBe(status)
      expect(err.message).toContain(String(status))
      expect(err.message).not.toContain(key)
      if (status === 429) expect(err.retryAfter).toBe("7")
      expect(keysInTurn(src("parallel", key))).toEqual([])
    })
  }

  test("a refused key rests and the next one is asked", async () => {
    const keys = ["pk-one-1111", "pk-two-2222"]
    const f = fake((req) => {
      if (req.headers["x-api-key"] === keys[0]) return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "120" } })
      return new Response(JSON.stringify({ results: [{ title: "P2", url: "https://p.example/2" }] }), { status: 200 })
    })
    const pages = await askSource(src("parallel", keys), "q", 6, undefined, f)
    expect(pages).toEqual([page("P2", "https://p.example/2", "")])
    expect(f.asked.map((c) => c.headers["x-api-key"])).toEqual(keys)
    expect(keysInTurn(src("parallel", keys))).toEqual([keys[1]])
  })

  test("a session refusal keeps status and Retry-After without the key or session ID", async () => {
    const key = "zc-coding-key-1234"
    const f = session({
      initialize: () =>
        new Response(JSON.stringify({ error: { message: `key ${key} and session sess-leaky-1234 refused` } }), {
          status: 401,
          headers: { "retry-after": "9" },
        }),
    })
    const err = await askSource(src("zai-coding", key), "q", 6, undefined, f).catch((e) => e)
    expect(err).toBeInstanceOf(Refused)
    expect(err.status).toBe(401)
    expect(err.retryAfter).toBe("9")
    expect(err.message).not.toContain(key)
    expect(f.asked.length).toBe(1)
  })

  test("no answer in time is said so", async () => {
    const c = new AbortController()
    c.abort()
    const f = fake(() => {
      throw new Error("aborted")
    })
    const err = await askSource(src("parallel", ""), "q", 6, c.signal, f).catch((e) => e)
    expect(err.message).toBe("no answer in time")
  })
})

describe("what the MCP sources leave out", () => {
  test("a hit with no address to open is left out; none left is no pages", async () => {
    const reply = rpc(1, {
      structuredContent: {
        results: [
          { title: "no", url: "", excerpts: ["x"] },
          { title: "relative", url: "/relative", excerpts: ["x"] },
          { title: "mail", url: "mailto:a@example.com", excerpts: ["x"] },
          { title: "creds", url: "https://user:pw@example.com/1", excerpts: ["x"] },
        ],
      },
    })
    expect((await ask("parallel", "", () => reply)).pages).toEqual([])
    expect((await ask("parallel", "", () => rpc(1, { structuredContent: { results: [] } }))).pages).toEqual([])
  })

  test("a reply with no results array can't be read", async () => {
    const err = await fail("parallel", "", () =>
      rpc(1, { content: [{ type: "text", text: "not json at all" }] }),
    )
    expect(err.status).toBeUndefined()
    expect(err.message).toContain("expected results array")
  })

  test("MCP results are read from structuredContent, nested text, or a bare array; bad JSON is an error", () => {
    const row = { title: "R", url: "https://r.example/1" }
    const fromStructured = extractMCPResults({ structuredContent: JSON.stringify({ search_result: [row] }) }, "L", {
      arrayKeys: ["results", "search_result"],
      maxJSONDepth: 3,
      decodeStructuredContent: true,
    })
    expect(fromStructured.results).toEqual([row])
    const fromText = extractMCPResults({ content: [{ type: "text", text: JSON.stringify({ results: [row] }) }] }, "L")
    expect(fromText.results).toEqual([row])
    const fromArray = extractMCPResults({ content: [{ type: "text", text: JSON.stringify([row]) }] }, "L")
    expect(fromArray.results).toEqual([row])
    expect(() => extractMCPResults({ content: [{ type: "text", text: "{bad" }] }, "L")).toThrow(/expected results array/)
  })
})

describe("the four in the list", () => {
  test("they are registered with the names and the keys the key field reads", () => {
    expect(Object.keys(VENDORS).length).toBe(31)
    expect(VENDORS.parallel.name).toBe("Parallel")
    expect(VENDORS.tinyfish.name).toBe("TinyFish")
    expect(VENDORS["zai-coding"].name).toBe("Z.ai Coding Plan")
    expect(VENDORS["zhipu-coding"].name).toBe("Zhipu Coding Plan")
    expect([VENDORS.parallel.keyOptional, VENDORS.tinyfish.keyOptional]).toEqual([true, true])
    expect([VENDORS["zai-coding"].keyOptional, VENDORS["zhipu-coding"].keyOptional]).toEqual([undefined, undefined])
    for (const id of ["parallel", "tinyfish", "zai-coding", "zhipu-coding"]) {
      expect(VENDORS[id].base.startsWith("https://")).toBe(true)
      expect(typeof VENDORS[id].execute).toBe("function")
      expect(VENDORS[id].request).toBeUndefined()
    }
  })
})
