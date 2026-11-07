// The search APIs magpie-search-mix can ask. Each is asked, and its reply read,
// the way magpie asks the same API in its own Web search list
// (yetone/magpie, internal/gateway/search_api.go), so a source here
// behaves as that API does in magpie.
//
// A vendor is { name, base, paths, keyOptional?, needsURL?, request, pages,
// inBodyError? }:
//   request({ base, key, query, n, url }) → { url, init }  the HTTP request
//   pages(json) → [{ title, url, text, age }]              its pages, in order
//   inBodyError(json, status) → { status, msg } | null     an error some APIs
//                                                          send with a 200
// Adding a search API is adding an entry here, with tests in test/vendors.test.js.

export const VERSION = "0.1.2"
export const USER_AGENT = `magpie-search-mix/${VERSION} (+https://github.com/mdwsk88/magpie-search-mix)`

// the most of a page's text passed on; magpie cuts it again to its own limit
export const PAGE_TEXT = 1500

// ---- reading replies ----------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

// plain is text without the tags some APIs mark matches with (Brave's
// <strong>), its common HTML entities decoded, on one line
export function plain(s) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    })
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
}

export function clip(s, n = PAGE_TEXT) {
  const r = [...s]
  return r.length <= n ? s : r.slice(0, n).join("") + "…"
}

export function firstRunes(s, n) {
  const r = [...s]
  return r.length > n ? r.slice(0, n).join("") : s
}

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v))

// field is o[name], else the key that differs only in case: Go's
// encoding/json, which magpie reads these replies with, matches so too
export function field(o, name) {
  if (!o || typeof o !== "object") return undefined
  if (name in o) return o[name]
  const want = name.toLowerCase()
  for (const k of Object.keys(o)) if (k.toLowerCase() === want) return o[k]
  return undefined
}

function page(title, url, text, age) {
  return { title: plain(title) || url, url, text: clip(plain(text)), age: str(age) }
}

// generic reads {results: [{title, url, content | summary | text |
// description | markdown | snippet, date}]}: Tavily, Exa, SearXNG, DeepSeek,
// Brave's web.results and Firecrawl's data.web
function generic(rs) {
  if (!Array.isArray(rs)) return []
  const out = []
  for (const r of rs) {
    const url = str(field(r, "url"))
    if (!url) continue
    let text = str(field(r, "content"))
    for (const k of ["summary", "text", "description", "markdown", "snippet"]) {
      if (text === "") text = str(field(r, k))
    }
    const age = ["date", "publishedDate", "published_date", "page_age", "age"].map((k) => str(field(r, k))).find(Boolean) ?? ""
    out.push(page(field(r, "title"), url, text, age))
  }
  return out
}

function youPages(j) {
  const r = field(j, "results")
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("no results in it")
  const hits = [...(Array.isArray(field(r, "web")) ? field(r, "web") : []), ...(Array.isArray(field(r, "news")) ? field(r, "news") : [])]
  const out = []
  for (const h of hits) {
    const url = str(field(h, "url"))
    if (!url) continue
    const snippets = field(h, "snippets")
    const text = (Array.isArray(snippets) ? snippets.map(str).join(" ") : "") || str(field(h, "description"))
    out.push(page(field(h, "title"), url, text, field(h, "page_age")))
  }
  return out
}

function volcPages(j) {
  const r = field(j, "Result")
  if (!r || typeof r !== "object") throw new Error("no Result in it")
  const hits = field(r, "WebResults")
  const out = []
  for (const h of Array.isArray(hits) ? hits : []) {
    const url = str(field(h, "Url"))
    if (!url) continue
    let text = str(field(h, "Summary"))
    if (!text.trim()) text = str(field(h, "Snippet"))
    let age = str(field(h, "PublishTime"))
    if (age.startsWith("1970-01-01")) age = "" // its time for a page it has none for
    out.push(page(field(h, "Title"), url, text, age))
  }
  return out
}

function wsaPages(j) {
  const r = field(j, "Response")
  const ps = field(r, "Pages")
  if (!r || !Array.isArray(ps)) throw new Error("no Response.Pages in it")
  const out = []
  for (const s of ps) {
    let h
    try {
      h = typeof s === "string" ? JSON.parse(s) : s
    } catch {
      continue
    }
    const url = str(field(h, "url"))
    if (!url) continue
    const title = str(field(h, "title"))
    let text = str(field(h, "passage"))
    // a passage that is only its title says less than its content
    if (plain(text) === "" || plain(text) === plain(title)) {
      const c = str(field(h, "content"))
      if (plain(c) !== "") text = c
    }
    out.push(page(title, url, text, field(h, "date")))
  }
  return out
}

// ---- errors sent with a 200 ---------------------------------------------------

// Doubao Search's error is in ResponseMetadata.Error, read by its code: a key
// it turns away (403), no credit or plan (402), rate limited (429)
function volcError(j, status) {
  const e = field(field(j, "ResponseMetadata"), "Error")
  if (!e || typeof e !== "object") return null
  let code = Number(field(e, "CodeN")) || 0
  if (!code) code = parseInt(str(field(e, "Code")), 10) || 0
  const msg = `${code} ${str(field(e, "Message"))}`.trim()
  if ([10401, 10403, 10409].includes(code)) return { status: 403, msg }
  if ([10406, 10408, 10410, 10412].includes(code)) return { status: 402, msg }
  if (code === 700429) return { status: 429, msg }
  return { status: status < 300 ? 502 : status, msg }
}

// Tencent Cloud answers 200 whenever it handled the request, its error in
// Response.Error {Code, Message}, read by the code before its first dot
function wsaError(j, status) {
  const e = field(field(j, "Response"), "Error")
  const code = str(field(e, "Code"))
  if (!code) return null
  const msg = `${code} ${str(field(e, "Message"))}`.trim()
  const head = code.split(".")[0]
  if (["AuthFailure", "UnauthorizedOperation", "ResourceNotFound"].includes(head)) return { status: 403, msg }
  if (["ResourceUnavailable", "LimitExceeded", "ResourceInsufficient"].includes(head)) return { status: 402, msg }
  if (head === "RequestLimitExceeded") return { status: 429, msg }
  return { status: status < 300 ? 502 : status, msg }
}

// You.com's error is a code ("payment_required"), its words in message
function youError(j) {
  const m = str(field(j, "message"))
  return m || null
}

// ---- asking -------------------------------------------------------------------

export const YOU_FREE = "https://api.you.com/v1/agents/search"

// wsaCntFor is the Cnt Yuanbao Search is asked for to find n pages: the
// fewest of the 10/20/30/40/50 it takes that covers n
export function wsaCntFor(n) {
  return Math.min(Math.max(Math.ceil(n / 10) * 10, 10), 50)
}

function headers(extra) {
  return { Accept: "application/json", "User-Agent": USER_AGENT, ...extra }
}
function post(url, body, extra = {}) {
  return { url, init: { method: "POST", headers: headers({ "Content-Type": "application/json", ...extra }), body: JSON.stringify(body) } }
}
function get(url, query, extra = {}) {
  const q = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))
  return { url: `${url}?${q}`, init: { method: "GET", headers: headers(extra) } }
}
const bearer = (key) => (key ? { Authorization: `Bearer ${key}` } : {})

export const VENDORS = {
  tavily: {
    name: "Tavily",
    base: "https://api.tavily.com",
    paths: ["/search"],
    request: ({ base, key, query, n }) => post(`${base}/search`, { query, max_results: n, search_depth: "basic" }, bearer(key)),
    pages: (j) => generic(field(j, "results")),
  },
  brave: {
    name: "Brave Search",
    base: "https://api.search.brave.com",
    paths: ["/res/v1/web/search"],
    request: ({ base, key, query, n }) => get(`${base}/res/v1/web/search`, { q: query, count: n }, key ? { "X-Subscription-Token": key } : {}),
    pages: (j) => generic(field(field(j, "web"), "results")),
  },
  exa: {
    name: "Exa",
    base: "https://api.exa.ai",
    paths: ["/search"],
    request: ({ base, key, query, n }) =>
      post(`${base}/search`, { query, numResults: n, contents: { text: { maxCharacters: PAGE_TEXT } } }, key ? { "X-API-Key": key } : {}),
    pages: (j) => generic(field(j, "results")),
  },
  firecrawl: {
    name: "Firecrawl",
    base: "https://api.firecrawl.dev",
    paths: ["/v2/search"],
    request: ({ base, key, query, n }) => post(`${base}/v2/search`, { query, limit: n }, bearer(key)),
    pages: (j) => {
      const d = field(j, "data")
      return generic(Array.isArray(d) ? d : field(d, "web")) // {web: […]} on v2, […] on v1
    },
  },
  you: {
    name: "You.com",
    base: "https://ydc-index.io",
    paths: ["/v1/search", "/v1/agents/search"],
    keyOptional: true, // its free search: 100 a day for each address
    request: ({ base, key, query, n, url }) =>
      key ? post(`${base}/v1/search`, { query, count: n }, { "X-API-Key": key }) : get(url ? `${base}/v1/agents/search` : YOU_FREE, { query, count: n }),
    pages: youPages,
    errorWords: youError,
  },
  deepseek: {
    name: "DeepSeek",
    base: "https://api.deepseek.com",
    paths: ["/v1/tools/search"],
    // a query of 1 to 128 characters; its page text is its summary
    request: ({ base, key, query, n }) => post(`${base}/v1/tools/search`, { query: firstRunes(query, 128), count: n }, bearer(key)),
    pages: (j) => generic(field(j, "results")),
  },
  volcengine: {
    name: "Doubao Search (Volcengine)",
    base: "https://open.feedcoopapi.com",
    paths: ["/search_api/web_search"],
    // a query of 1 to 100 characters, web pages only, and only those with a URL
    request: ({ base, key, query, n }) =>
      post(`${base}/search_api/web_search`, { Query: firstRunes(query, 100), SearchType: "web", Count: n, Filter: { NeedUrl: true } }, bearer(key)),
    pages: volcPages,
    inBodyError: volcError,
  },
  wsa: {
    name: "Yuanbao Search (Tencent Cloud)",
    base: "https://api.wsa.cloud.tencent.com",
    paths: ["/SearchPro"],
    request: ({ base, key, query, n }) => post(`${base}/SearchPro`, { Query: query, Cnt: wsaCntFor(n) }, bearer(key)),
    pages: wsaPages,
    inBodyError: wsaError,
  },
  searxng: {
    name: "SearXNG",
    base: "",
    paths: ["/search"],
    keyOptional: true,
    needsURL: true,
    request: ({ base, key, query }) => get(`${base}/search`, { q: query, format: "json" }, bearer(key)),
    pages: (j) => generic(field(j, "results")),
  },
}

// baseOf is where a source is asked: its own address without a closing
// slash or the vendor's path (a URL given with /search is that base), else
// the vendor's
export function baseOf(source) {
  const v = VENDORS[source.vendor]
  if (!source.url) return v.base
  let u = source.url.replace(/\/+$/, "")
  for (const p of v.paths) {
    if (u.length > p.length && u.toLowerCase().endsWith(p.toLowerCase())) {
      u = u.slice(0, -p.length).replace(/\/+$/, "")
      break
    }
  }
  return u
}
