// magpie-search-mix's sources are written in its key field in magpie (Settings ›
// Models › Web search), so their keys stay in magpie's own key store:
//
//   deepseek=sk-…+you+tavily=tvly-a|tvly-b+searxng@https://searx.example.com
//
// Sources are joined by "+", in the order they are asked. Each is
//   <api>[=<key>[|<key>…]][@<base url>]
// magpie splits a key field at commas, semicolons, spaces and new lines into
// several keys and hands a search API one of them per search, so the sources
// have to be one unbroken string. (Spaces, semicolons and commas are read as
// "+" too, for scripts/try.js; in magpie they never reach the plugin.)

import { VENDORS } from "./vendors.js"

const TOKEN = /^([a-z][a-z0-9-]*)(?:=([^@]*))?(?:@(.+))?$/i

export class ConfigError extends Error {}

const ids = () => Object.keys(VENDORS).join(", ")

export const HOW = 'join sources with "+", e.g. deepseek=<key>+you+tavily=<key>'

// parseSources reads the key field into [{ vendor, name, keys, url, label }].
// What is wrong is said by place and API, never by a key.
export function parseSources(text) {
  const raw = String(text ?? "").trim()
  if (!raw) {
    throw new ConfigError(`no sources in magpie-search-mix's key field: ${HOW} (APIs: ${ids()})`)
  }
  const sources = []
  const errors = []
  const seen = new Map()
  raw.split(/[+\s;,]+/).filter(Boolean).forEach((token, i) => {
    const at = `source ${i + 1}`
    const m = TOKEN.exec(token)
    if (!m) {
      errors.push(`${at} isn't <api>[=<key>][@<url>]`)
      return
    }
    const vendor = m[1].toLowerCase()
    const v = VENDORS[vendor]
    if (!v) {
      errors.push(`${at}: no search API "${vendor}" (one of ${ids()})`)
      return
    }
    const keys = (m[2] ?? "").split("|").map((k) => k.trim()).filter(Boolean)
    let url = (m[3] ?? "").trim()
    if (url) {
      let u
      try {
        u = new URL(url)
      } catch {}
      if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || !u.host) {
        errors.push(`${at} (${vendor}): its address isn't an http:// or https:// URL`)
        return
      }
      if (u.search || u.hash) {
        errors.push(`${at} (${vendor}): give its base URL alone, without ?query or #fragment`)
        return
      }
      url = u.href.replace(/\/+$/, "")
    }
    if (!keys.length && !v.keyOptional) {
      errors.push(`${at}: ${vendor} needs its key, as ${vendor}=<key>`)
      return
    }
    if (!url && v.needsURL) {
      errors.push(`${at}: ${vendor} needs its address, as ${vendor}@https://…`)
      return
    }
    const n = (seen.get(vendor) ?? 0) + 1
    seen.set(vendor, n)
    sources.push({ vendor, name: v.name, keys, url, label: n > 1 ? `${vendor}#${n}` : vendor })
  })
  if (errors.length) throw new ConfigError(`magpie-search-mix's key field: ${errors.join("; ")}`)
  return sources
}
