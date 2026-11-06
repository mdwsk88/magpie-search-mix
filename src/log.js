// An optional log: one line per search with each source's time, pages or
// error and how many pages were merged. Never the query, never a key.
// Off unless the plugin's options name a folder: {"logDir": "/path"}.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"

export function makeLog(dir, most = 1 << 20) {
  const file = join(dir, "search-mix.jsonl")
  return (entry) => {
    try {
      mkdirSync(dir, { recursive: true })
      try {
        if (statSync(file).size > most) renameSync(file, `${file}.1`)
      } catch {}
      appendFileSync(file, JSON.stringify(entry) + "\n")
    } catch {}
  }
}
