// magpie-search-mix: a web search API for magpie that asks two (or more) search APIs
// at once and merges their pages. Its sources and their keys are written in
// its key field in Settings › Models › Web search; see README.md.
//
// Only the plugin function is exported: magpie calls every function an
// entry file exports as a plugin.

import { ConfigError, HOW, parseSources } from "./src/config.js"
import { makeLog } from "./src/log.js"
import { mixSearch } from "./src/mix.js"

export const SearchMix = async (_input, options = {}) => {
  const width = Math.max(1, Math.trunc(Number(options?.width)) || 2)
  const perSourceMs = Math.max(1, Number(options?.perSourceSeconds) || 10) * 1000
  const log = typeof options?.logDir === "string" && options.logDir ? makeLog(options.logDir) : undefined
  return {
    search: {
      mix: {
        name: "magpie-search-mix",
        keysURL: "https://github.com/mdwsk88/magpie-search-mix#set-it-up",
        keyOptional: false,
        async execute({ query, count, key }, ctx) {
          const sources = parseSources(key)
          // one source is what magpie hands over when the sources were split
          // by spaces or commas: magpie takes those as several keys, one a search
          if (sources.length < 2) throw new ConfigError(`magpie-search-mix got one source (${sources[0].label}), so it has nothing to mix: ${HOW}`)
          return mixSearch({ query, count, sources, width, perSourceMs, signal: ctx?.abort, log })
        },
      },
    },
  }
}
