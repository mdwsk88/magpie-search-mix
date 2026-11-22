// REST search APIs from magpie-websearch's providers and search1api.

import { bearer, field, firstRunes, get, post, webPage } from "./vendors.js"

// failure carries the status magpie reads: a refusal rests that key.
function failure(status, message, retryAfter) {
  const e = new Error(message)
  e.status = status
  if (retryAfter) e.retryAfter = retryAfter
  return e
}

function words(json, body, status) {
  const e = field(json, "error")
  const m =
    field(e, "message") ?? field(json, "message") ?? field(json, "msg") ?? field(json, "error_msg") ?? field(json, "readableMessage") ?? (typeof e === "string" ? e : undefined)
  if (typeof m === "string" && m.trim()) return `${status} ${m.trim()}`
  const t = String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
  return t ? `${status} ${t}` : String(status)
}

function said(code, json) {
  const m = field(json, "message") ?? field(json, "msg") ?? field(json, "error_msg") ?? field(json, "readableMessage")
  const c = String(code ?? "").trim().slice(0, 80)
  const w = typeof m === "string" ? m.trim().slice(0, 200) : ""
  return c ? (w ? `${c}: ${w}` : c) : w || "it said no"
}

async function call(fetchImpl, { url, init }, signal, { fixed = {}, hide = false } = {}) {
  const res = await fetchImpl(url, { ...init, signal, redirect: "manual" })
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${res.status}: it sends the search on to another address, which isn't given its key; set that address instead`)
  }
  const retryAfter = res.headers?.get?.("retry-after") ?? ""
  const body = await res.text()
  let json
  try {
    json = JSON.parse(body)
  } catch {}
  if (res.status >= 300) {
    const told = fixed[res.status] ?? (hide ? `${res.status}: it turned the search away` : words(json, body, res.status))
    throw failure(res.status, told, retryAfter)
  }
  if (json === undefined) throw new Error("unexpected reply: not JSON")
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("unexpected reply: not an object")
  return json
}

function rows(list, what) {
  if (!Array.isArray(list)) throw new Error(`no ${what} in it`)
  return list
}

const moonshotAt = (name, site) => ({
  name,
  base: site,
  paths: ["/v1/tools/search"],
  async execute({ base, key, query, n, signal, fetchImpl }) {
    const json = await call(fetchImpl, post(`${base}/v1/tools/search`, { text_query: query, limit: n }, bearer(key)), signal)
    const hits = field(json, "search_results")
    if (hits == null) return []
    return rows(hits, "search_results").map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "snippet"), field(h, "date"))).filter(Boolean)
  },
})

const zhipuAt = (name, site, china) => ({
  name,
  base: site,
  paths: ["/api/paas/v4/web_search"],
  async execute({ base, key, query, n, signal, fetchImpl }) {
    const body = {
      search_query: china ? firstRunes(query, 70) : query,
      search_engine: china ? "search_std" : "search-prime",
      ...(china ? { search_intent: false } : {}),
      count: n,
    }
    const json = await call(fetchImpl, post(`${base}/api/paas/v4/web_search`, body, bearer(key)), signal)
    const code = field(json, "code")
    if (code != null && ![0, "0", 200, "200"].includes(code)) throw new Error(`${name.toLowerCase()}: ${said(code, json)}`)
    return rows(field(json, "search_result"), "search_result")
      .map((h) => webPage(field(h, "title"), field(h, "link"), field(h, "content"), field(h, "publish_date")))
      .filter(Boolean)
  },
})

export const REST = {
  anysearch: {
    name: "AnySearch",
    base: "https://api.anysearch.com",
    paths: ["/v1/search"],
    keyOptional: true, // it answers without a key, at a smaller allowance
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/v1/search`, { query, max_results: n, format: "markdown" }, bearer(key)), signal, {
        fixed: { 402: "402: its quota is used up; add a new key or wait for it to reset" },
      })
      const code = field(json, "code")
      if (code === undefined) throw new Error("unexpected reply: no code in it")
      if (Number(code) !== 0) throw new Error(`anysearch: ${said(code, json)}`)
      return rows(field(field(json, "data"), "results"), "data.results")
        .map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "content") ?? field(h, "snippet")))
        .filter(Boolean)
    },
  },
  bocha: {
    name: "Bocha",
    base: "https://api.bochaai.com",
    paths: ["/v1/web-search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/v1/web-search`, { query, count: n, summary: false }, bearer(key)), signal)
      const code = field(json, "code")
      if (code !== undefined && Number(code) !== 200) throw new Error(`bocha: ${said(code, json)}`)
      const data = field(json, "data")
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("unexpected reply: no data in it")
      const web = field(data, "webPages")
      if (web == null) return []
      return rows(field(web, "value"), "webPages.value")
        .map((h) => webPage(field(h, "name"), field(h, "url"), field(h, "snippet"), field(h, "datePublished") ?? field(h, "dateLastCrawled")))
        .filter(Boolean)
    },
  },
  jina: {
    name: "Jina",
    base: "https://s.jina.ai",
    paths: ["/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/search`, { q: query, num: n }, { ...bearer(key), "X-Respond-With": "no-content" }), signal)
      const code = field(json, "code")
      const state = field(json, "status")
      if ((code !== undefined && Number(code) !== 200) || (state !== undefined && Number(state) !== 20000)) {
        throw new Error(`jina: ${said(state !== undefined && Number(state) !== 20000 ? state : code, json)}`)
      }
      return rows(field(json, "data"), "data")
        .map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "description"), field(h, "publishedTime")))
        .filter(Boolean)
    },
  },
  kagi: {
    name: "Kagi",
    base: "https://kagi.com",
    paths: ["/api/v1/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/api/v1/search`, { query, workflow: "search", limit: n }, bearer(key)), signal)
      const error = field(json, "error")
      if (error != null) throw new Error(`kagi: ${String(typeof error === "string" ? error : JSON.stringify(error)).slice(0, 200)}`)
      const data = field(json, "data")
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("unexpected reply: no data in it")
      const hits = field(data, "search")
      if (hits == null) return []
      return rows(hits, "data.search").map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "snippet"), field(h, "time"))).filter(Boolean)
    },
  },
  keenable: {
    name: "Keenable",
    base: "https://api.keenable.ai",
    paths: ["/v1/search", "/v1/search/public"],
    keyOptional: true, // its public endpoint answers without a key
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const where = key ? `${base}/v1/search` : `${base}/v1/search/public`
      const json = await call(fetchImpl, post(where, { query, max_results: n }, { "X-Keenable-Title": "magpie-search-mix", ...(key ? { "X-API-Key": key } : {}) }), signal, {
        fixed: key ? { 402: "402: its credits are used up; add credits or wait for the allowance to reset" } : {},
      })
      return rows(field(json, "results"), "results")
        .map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "snippet") ?? field(h, "description"), field(h, "published_at")))
        .filter(Boolean)
    },
  },
  linkup: {
    name: "Linkup",
    base: "https://api.linkup.so",
    paths: ["/v1/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/v1/search`, { q: query, depth: "fast", outputType: "searchResults", maxResults: n }, bearer(key)), signal)
      return rows(field(json, "results"), "results")
        .filter((h) => field(h, "type") !== "image") // an image has no page to open
        .map((h) => webPage(field(h, "name"), field(h, "url"), field(h, "content")))
        .filter(Boolean)
    },
  },
  metaso: {
    name: "Metaso",
    base: "https://metaso.cn",
    paths: ["/api/v1/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/api/v1/search`, { q: query, scope: "webpage", size: n, concise: true }, bearer(key)), signal)
      const hits = field(json, "webpages") ?? field(json, "results") ?? field(json, "papers") ?? field(json, "documents") ?? field(json, "data")
      if (hits == null) return []
      return rows(hits, "webpages")
        .map((h) => webPage(field(h, "title"), field(h, "link") ?? field(h, "url"), field(h, "snippet") ?? field(h, "content"), field(h, "date")))
        .filter(Boolean)
    },
  },
  moonshot: moonshotAt("Moonshot", "https://api.moonshot.ai"),
  "moonshot-cn": moonshotAt("Moonshot CN", "https://api.moonshot.cn"),
  ollama: {
    name: "Ollama",
    base: "https://ollama.com",
    paths: ["/api/web_search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/api/web_search`, { query, max_results: n }, bearer(key)), signal)
      return rows(field(json, "results"), "results").map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "content"))).filter(Boolean)
    },
  },
  perplexity: {
    name: "Perplexity",
    base: "https://api.perplexity.ai",
    paths: ["/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/search`, { query, max_results: n, search_type: "web" }, bearer(key)), signal)
      return rows(field(json, "results"), "results")
        .map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "snippet"), field(h, "date") ?? field(h, "last_updated")))
        .filter(Boolean)
    },
  },
  querit: {
    name: "Querit",
    base: "https://api.querit.ai",
    paths: ["/v1/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/v1/search`, { query, count: n }, bearer(key)), signal)
      const code = field(json, "error_code")
      if (code !== undefined && Number(code) !== 200) throw new Error(`querit: ${said(code, json)}`)
      const hits = field(field(json, "results"), "result")
      if (hits == null) return []
      return rows(hits, "results.result")
        .map((h) => {
          const sentence = field(h, "sentence")
          const text = field(h, "snippet") ?? (Array.isArray(sentence) ? sentence.join(" ") : "")
          return webPage(field(h, "title"), field(h, "url"), text, field(h, "page_age"))
        })
        .filter(Boolean)
    },
  },
  serpapi: {
    name: "SerpApi",
    base: "https://serpapi.com",
    paths: ["/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      // its key is a query parameter: mix.js masks it in what a refusal says
      const json = await call(fetchImpl, get(`${base}/search`, { engine: "google", output: "json", q: query, api_key: key }), signal)
      const state = field(field(json, "search_metadata"), "status")
      if (state === "Error") throw new Error("serpapi couldn't run the search")
      if (state === "Processing" || state === "Queued") throw new Error(`serpapi is still ${String(state).toLowerCase()} the search`)
      const hits = field(json, "organic_results")
      if (hits == null) return []
      return rows(hits, "organic_results").map((h) => webPage(field(h, "title"), field(h, "link"), field(h, "snippet"), field(h, "date"))).filter(Boolean)
    },
  },
  serper: {
    name: "Serper",
    base: "https://google.serper.dev",
    paths: ["/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/search`, { q: query, num: n }, { "X-API-KEY": key }), signal)
      const word = field(json, "message")
      if (word != null || field(json, "error") != null) throw new Error(`serper: ${String(word ?? JSON.stringify(field(json, "error"))).slice(0, 200)}`)
      const hits = field(json, "organic")
      if (hits == null) return []
      return rows(hits, "organic").map((h) => webPage(field(h, "title"), field(h, "link"), field(h, "snippet"), field(h, "date"))).filter(Boolean)
    },
  },
  stepfun: {
    name: "StepFun",
    base: "https://api.stepfun.com",
    paths: ["/v1/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const json = await call(fetchImpl, post(`${base}/v1/search`, { query, n }, bearer(key)), signal)
      return rows(field(json, "results"), "results")
        .map((h) => webPage(field(h, "title"), field(h, "url"), field(h, "snippet") ?? field(h, "content"), field(h, "time")))
        .filter(Boolean)
    },
  },
  zai: zhipuAt("Z.ai", "https://api.z.ai", false),
  zhipu: zhipuAt("Zhipu", "https://open.bigmodel.cn", true),
  search1api: {
    name: "Search1API",
    base: "https://api.search1api.com",
    paths: ["/search"],
    async execute({ base, key, query, n, signal, fetchImpl }) {
      const asked = { query: String(query ?? "").trim(), search_service: "google", max_results: Math.min(Math.max(Math.trunc(n) || 1, 1), 50), crawl_results: 0 }
      // its refusal body can repeat the key: only the status is said
      const json = await call(fetchImpl, post(`${base}/search`, asked, bearer(key)), signal, { hide: true })
      return rows(field(json, "results"), "results")
        .map((h) => webPage(field(h, "title"), field(h, "link"), field(h, "snippet"), field(h, "published_date")))
        .filter(Boolean)
    },
  },
}
