// Asking the sources and merging what they found.
//
// mixSearch asks the first `width` sources at once (2 by default); one that
// fails, finds nothing, takes longer than perSourceMs or has every key
// resting gives its place to the next source not asked yet. The pages are
// taken in turn, in the sources' order (each one's first, then each one's
// second…), a page two sources found kept once, at most `count`.
//
// The sources' order is the key field's ("listed", the default) or, with
// order "random", shuffled anew for each search; all of the above then
// follows the shuffled order.
//
// Nothing found anywhere is no pages: magpie then asks the next search API
// in its list. Every source failing is a plain error, never one with a
// status, so magpie doesn't rest the key field it came from.

import { createHash } from "node:crypto"
import { VENDORS, baseOf, field } from "./vendors.js"

export const COUNT_DEFAULT = 6
export const COUNT_MOST = 20

// ---- keys that rest after a refusal, as magpie rests them ----------------------

const rests = new Map() // "vendor|url|key digest" → { until, why }
const turns = new Map() // source label → the key whose turn it is

export function resetState() {
  rests.clear()
  turns.clear()
}

function keyID(source, key) {
  const k = key ? createHash("sha256").update(key).digest("hex").slice(0, 12) : "free"
  return `${source.vendor}|${source.url}|${k}`
}

// restFor: a key turned away (401/403) rests 10 minutes; out of credit (402,
// Tavily's 432/433) an hour; rate limited as long as Retry-After says, held
// to 30 seconds through 10 minutes, a minute when it says nothing
export function restFor(vendor, status, retryAfter, now = Date.now()) {
  if (status === 401 || status === 403) return { ms: 10 * 60_000, why: "turned away" }
  if (status === 402 || (vendor === "tavily" && (status === 432 || status === 433))) return { ms: 60 * 60_000, why: "out of credit" }
  let ms = 60_000
  const s = String(retryAfter ?? "").trim()
  if (/^\d+$/.test(s)) ms = Number(s) * 1000
  else if (s && !Number.isNaN(Date.parse(s))) ms = Date.parse(s) - now
  return { ms: Math.min(Math.max(ms, 30_000), 10 * 60_000), why: "rate limited" }
}

function resting(source, key, now) {
  const r = rests.get(keyID(source, key))
  return r && now < r.until ? r : undefined
}

// keysInTurn are a source's keys in the order this search asks them, from
// the one whose turn it is, those resting left out; [""] for one with none
export function keysInTurn(source, now = Date.now()) {
  const keys = source.keys.length ? source.keys : [""]
  let order = keys.map((_, i) => i)
  if (keys.length > 1) {
    const start = (turns.get(source.label) ?? 0) % keys.length
    turns.set(source.label, start + 1)
    order = [...order.slice(start), ...order.slice(0, start)]
  }
  return order.map((i) => keys[i]).filter((k) => !resting(source, k, now))
}

// ---- asking one source --------------------------------------------------------

export class Refused extends Error {
  constructor(status, message, retryAfter) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

const REFUSALS = new Set([401, 402, 403, 429, 432, 433])

export function mask(key) {
  if (!key) return ""
  return key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`
}

function unsay(s, key) {
  return key ? String(s).split(key).join(mask(key)) : String(s)
}

function errorWords(body, status) {
  try {
    const j = JSON.parse(body)
    const m = field(field(j, "error"), "message") ?? field(j, "message") ?? field(field(j, "detail"), "error") ?? field(j, "detail") ?? field(j, "error")
    if (typeof m === "string" && m.trim()) return `${status} ${m.trim()}`
  } catch {}
  const t = String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
  return t ? `${status} ${t}` : String(status)
}

// askSource asks a source with its keys in turn until one is taken: a key
// refused (401/402/403/429/432/433) rests and the next is asked; anything
// else (no answer in time, 5xx, a reply it can't read) isn't the key's
// doing, and no other key is tried
export async function askSource(source, query, n, signal, fetchImpl = fetch, now = Date.now) {
  const v = VENDORS[source.vendor]
  const keys = keysInTurn(source, now())
  if (keys.length === 0) throw new Error("every key is resting after a refusal")
  let last
  for (const key of keys) {
    const { url, init } = v.request({ base: baseOf(source), key, query, n, url: source.url })
    let res
    try {
      res = await fetchImpl(url, { ...init, signal, redirect: "manual" })
    } catch (e) {
      if (signal?.aborted) throw new Error("no answer in time")
      throw new Error(unsay(e?.message ?? e, key))
    }
    const body = await res.text()
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`${res.status}: it sends the search on to another address, which isn't given its key; set that address instead`)
    }
    let json
    try {
      json = JSON.parse(body)
    } catch {}
    let status = res.status
    let msg = ""
    const inBody = json !== undefined && v.inBodyError ? v.inBodyError(json, status) : null
    if (inBody) ({ status, msg } = inBody)
    if (status >= 300) {
      const words = !msg && json !== undefined && v.errorWords ? v.errorWords(json) : null
      if (words) msg = `${status} ${words}`
      if (!msg) msg = errorWords(body, status)
      msg = unsay(msg, key)
      if (!REFUSALS.has(status)) throw new Error(msg)
      const retryAfter = res.headers?.get?.("retry-after") ?? ""
      const r = restFor(source.vendor, status, retryAfter, now())
      rests.set(keyID(source, key), { until: now() + r.ms, why: r.why })
      last = new Refused(status, `${msg} (${r.why})`, retryAfter)
      continue
    }
    rests.delete(keyID(source, key))
    if (json === undefined) throw new Error("unexpected reply: not JSON")
    let pages
    try {
      pages = v.pages(json)
    } catch (e) {
      throw new Error(`unexpected reply: ${e?.message ?? e}`)
    }
    return pages.slice(0, n)
  }
  throw last
}

// ---- merging ------------------------------------------------------------------

// pageKey is a page's address as two APIs may write it apart: http and
// https alike, the host in lower case without www., no #fragment or closing
// slash; its ?query kept, as another query may be another page
export function pageKey(raw) {
  const s = String(raw ?? "").trim()
  try {
    const u = new URL(s)
    return `https://${u.host.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`
  } catch {
    return s
  }
}

// interleave takes each list's first page, then each one's second…, a page
// already taken left out (its text given to the first when that had none),
// at most n
export function interleave(lists, n) {
  const out = []
  const at = new Map()
  const deepest = Math.max(0, ...lists.map((l) => l.length))
  for (let rank = 0; rank < deepest && out.length < n; rank++) {
    for (const l of lists) {
      const p = l[rank]
      if (!p) continue
      const k = pageKey(p.url)
      const seen = at.get(k)
      if (seen !== undefined) {
        if (!out[seen].text && p.text) out[seen] = { ...out[seen], text: p.text }
        continue
      }
      if (out.length >= n) continue
      at.set(k, out.length)
      out.push(p)
    }
  }
  return out
}

// ---- a mixed search -----------------------------------------------------------

export function countOf(count) {
  const n = Math.trunc(Number(count))
  return Number.isFinite(n) && n > 0 ? Math.min(n, COUNT_MOST) : COUNT_DEFAULT
}

// hide keeps the query and the keys out of what is said and logged
function hide(text, query, keys) {
  let s = String(text ?? "")
  const q = String(query ?? "").trim()
  if (q) {
    for (const form of [q, encodeURIComponent(q), new URLSearchParams({ q }).toString().slice(2)]) s = s.split(form).join("…")
  }
  for (const k of keys) if (k) s = s.split(k).join(mask(k))
  return s.slice(0, 300)
}

// shuffled is a copy of list in an order drawn with random (Fisher–Yates),
// every order as likely as any other
function shuffled(list, random) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

export async function mixSearch({ query, count, sources: listed, width = 2, order = "listed", perSourceMs = 10_000, signal, fetchImpl = fetch, now = Date.now, random = Math.random, log }) {
  const sources = order === "random" ? shuffled(listed, random) : listed
  const n = countOf(count)
  const started = now()
  const queue = [...sources]
  const found = new Array(sources.length)
  const asked = []
  const allKeys = sources.flatMap((s) => s.keys)
  const slot = async () => {
    while (queue.length && !signal?.aborted) {
      const source = queue.shift()
      const t0 = now()
      const one = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(perSourceMs)])
      try {
        const pages = await askSource(source, query, n, one, fetchImpl, now)
        asked.push({ source: source.label, ms: now() - t0, pages: pages.length })
        if (pages.length) {
          found[sources.indexOf(source)] = pages
          return
        }
      } catch (e) {
        const timedOut = one.aborted && !signal?.aborted
        asked.push({
          source: source.label,
          ms: now() - t0,
          error: hide(timedOut ? "no answer in time" : e?.message ?? e, query, allKeys),
          ...(e instanceof Refused ? { status: e.status } : {}),
        })
      }
    }
  }
  const w = Math.max(1, Math.min(Math.trunc(Number(width)) || 2, sources.length))
  await Promise.all(Array.from({ length: w }, slot))
  const lists = found.filter(Boolean)
  const pages = interleave(lists, n)
  log?.({ at: new Date(started).toISOString(), count: n, width: w, ms: now() - started, asked, merged: pages.length })
  if (lists.length) return pages
  if (!asked.some((a) => a.error)) return []
  throw new Error(asked.map((a) => `${a.source}: ${a.error ?? "found nothing"}`).join("; "))
}
