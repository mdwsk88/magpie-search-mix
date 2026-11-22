import { field, get, post, webPage } from "./vendors.js"
import { callMCPSearch, callSessionMCPTool, extractMCPResults } from "./mcp.js"

const PARALLEL_MCP = "https://mcp.parallel.ai/mcp"
const TINYFISH_MCP = "https://agent.tinyfish.ai/mcp"

function failure(status, message, retryAfter) {
  const e = new Error(message)
  e.status = status
  if (retryAfter) e.retryAfter = retryAfter
  return e
}

function words(json, body, status) {
  const word = field(field(json, "error"), "message") ?? field(json, "message") ?? field(json, "error")
  if (typeof word === "string" && word.trim()) return `${status} ${word.trim().slice(0, 200)}`
  const text = String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
  return text ? `${status} ${text}` : `${status}: it turned the search away`
}

async function call(fetchImpl, request, signal) {
  const res = await fetchImpl(request.url, { ...request.init, signal, redirect: "manual" })
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${res.status}: it sends the search on to another address, which isn't given its key; set that address instead`)
  }
  const retryAfter = res.headers?.get?.("retry-after") ?? ""
  const body = await res.text()
  let json
  try {
    json = JSON.parse(body)
  } catch {}
  if (res.status < 200 || res.status >= 300) throw failure(res.status, words(json, body, res.status), retryAfter)
  if (json === undefined) throw new Error("unexpected reply: not JSON")
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("unexpected reply: not an object")
  return json
}

function rows(list, what) {
  if (!Array.isArray(list)) throw new Error(`no ${what} in it`)
  return list
}

const word = (query) => String(query ?? "").trim().replace(/\s+/g, " ")
const excerpts = (value) => (Array.isArray(value) ? value.filter((s) => typeof s === "string" && s).join("\n\n") : "")

const parallelPages = (results) =>
  results
    .map((h) => webPage(field(h, "title"), field(h, "url"), excerpts(field(h, "excerpts")), field(h, "publish_date")))
    .filter(Boolean)

const tinyfishPages = (results) =>
  results.map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "snippet"), field(h, "date"))).filter(Boolean)

const codingAt = (name, site, path) => ({
  name,
  base: site,
  paths: [path],
  async execute({ base, key, query, n, signal, fetchImpl }) {
    const { result } = await callSessionMCPTool({
      endpoint: `${base}${path}`,
      headers: { Authorization: `Bearer ${key}` },
      toolNames: ["web_search_prime", "webSearchPrime"],
      argumentsForSchema(schema) {
        const args = { search_query: word(query) }
        if (schema.properties && Object.hasOwn(schema.properties, "count")) args.count = n
        return args
      },
      signal,
      fetchImpl,
      label: name,
    })
    const { results } = extractMCPResults(result, name, { arrayKeys: ["results", "search_result"], maxJSONDepth: 3, decodeStructuredContent: true })
    return rows(results, "results")
      .map((h) => webPage(field(h, "title"), field(h, "link") || field(h, "url"), field(h, "content") || field(h, "snippet"), field(h, "publish_date")))
      .filter(Boolean)
      .slice(0, n)
  },
})

export const MCP = {
  parallel: {
    name: "Parallel",
    base: "https://api.parallel.ai",
    paths: ["/v1/search", "/mcp"],
    keyOptional: true,
    async execute({ base, key, query, n, url, signal, fetchImpl }) {
      const q = word(query)
      if (key) {
        const body = {
          objective: q,
          search_queries: [q],
          mode: "fast",
          advanced_settings: { max_results: n, excerpt_settings: { max_chars_per_result: 4000 } },
        }
        const json = await call(fetchImpl, post(`${base}/v1/search`, body, { "x-api-key": key }), signal)
        return parallelPages(rows(field(json, "results"), "results")).slice(0, n)
      }
      const endpoint = url ? `${base}/mcp` : PARALLEL_MCP
      const { results } = await callMCPSearch(endpoint, "web_search", { objective: q, search_queries: [q] }, { signal, fetchImpl, label: "Parallel" })
      return parallelPages(rows(results, "results")).slice(0, n)
    },
  },
  tinyfish: {
    name: "TinyFish",
    base: "https://api.search.tinyfish.ai/",
    paths: ["/mcp"],
    keyOptional: true,
    async execute({ base, key, query, n, url, signal, fetchImpl }) {
      const q = word(query)
      const params = { query: q, domain_type: "web" }
      let json
      if (key) {
        const root = base.endsWith("/") ? base : `${base}/`
        json = await call(fetchImpl, get(root, params, { "X-API-Key": key }), signal)
      } else {
        const endpoint = url ? `${base}/mcp` : TINYFISH_MCP
        json = await callMCPSearch(endpoint, "search", params, { signal, fetchImpl, label: "TinyFish", headers: { "X-TinyFish-Access-Mode": "keyless" } })
      }
      return tinyfishPages(rows(field(json, "results"), "results")).slice(0, n)
    },
  },
  "zai-coding": codingAt("Z.ai Coding Plan", "https://api.z.ai", "/api/mcp/web_search_prime/mcp"),
  "zhipu-coding": codingAt("Zhipu Coding Plan", "https://open.bigmodel.cn", "/api/mcp/web_search_prime/mcp"),
}
