// Try one search with real APIs, outside magpie, and see what each source did:
//   SEARCH_MIX_SOURCES='you+tavily=tvly-…' bun scripts/try.js "a question" [count] [width] [order]
// The sources are written as in magpie-search-mix's key field. No key is printed.

import { parseSources } from "../src/config.js"
import { mixSearch } from "../src/mix.js"

const [query, count, width, order] = process.argv.slice(2)
if (!query || !process.env.SEARCH_MIX_SOURCES) {
  console.error(`usage: SEARCH_MIX_SOURCES='you+tavily=<key>' bun scripts/try.js "a question" [count] [width] [order]`)
  process.exit(2)
}
const sources = parseSources(process.env.SEARCH_MIX_SOURCES)
console.log(`sources: ${sources.map((s) => s.label).join(", ")}`)
let entry
let pages = []
let failed
try {
  pages = await mixSearch({ query, count, width: Number(width) || 2, order, sources, log: (e) => (entry = e), signal: AbortSignal.timeout(30_000) })
} catch (e) {
  failed = e
}
for (const a of entry?.asked ?? []) console.log(`- ${a.source}: ${a.ms} ms, ${a.error ? `failed: ${a.error}` : `${a.pages} pages`}`)
if (failed) {
  console.log(`failed: ${failed.message}`)
  process.exit(1)
}
console.log(`${pages.length} pages merged in ${entry?.ms} ms:`)
pages.forEach((p, i) => console.log(`${i + 1}. ${p.title.slice(0, 80)} — ${p.url}`))
