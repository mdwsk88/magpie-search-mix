# Search Mix for magpie

[中文说明](README.zh-CN.md)

A web search API for [magpie](https://github.com/yetone/magpie) that asks two or more search APIs at once and gives the agent their pages together: taken in turn from each, a page they both found kept once.

An unofficial community plugin by mdwsk88. It is not part of magpie.

## What it does

When an agent searches through magpie (Claude Code's WebSearch, Codex's web_search, or magpie's web-search MCP server) and Search Mix is first in magpie's Web search list:

1. It asks the first two of its sources at once.
2. A source that fails, finds nothing, takes longer than 10 seconds, or has every key resting after a refusal gives its place to the next source that hasn't been asked yet.
3. It takes the pages in turn: each source's first, then each one's second, and so on. A page two sources found is kept once (by its address), up to the number of pages the search asked for.

If every source finds nothing, it returns no pages. If every source fails, it fails. Either way magpie goes on to the next search API in its list, so keep your usual APIs below it as a fallback.

## Search APIs it can mix

Each one is asked, and its reply read, the way magpie asks the same API in its own Web search list.

| Id | Search API | Key |
|---|---|---|
| `tavily` | Tavily | needed |
| `brave` | Brave Search | needed |
| `exa` | Exa | needed |
| `firecrawl` | Firecrawl | needed |
| `you` | You.com | optional: without one, its free search (100 a day for each address) |
| `deepseek` | DeepSeek search | needed |
| `volcengine` | Doubao Search (Volcengine) | needed |
| `wsa` | Yuanbao Search (Tencent Cloud) | needed |
| `searxng` | SearXNG | optional; needs its address |

## Install

```sh
magpie plugin add github:mdwsk88/magpie-search-mix
```

## Set it up

In magpie's **Settings › Models › Web search**, add **Search Mix**, move it to the top, and write its sources in its key field, joined by `+`:

```text
deepseek=sk-…+you+tavily=tvly-…
```

From a terminal:

```sh
magpie search add magpie-search-mix:mix 'deepseek=sk-…+you+tavily=tvly-…'
magpie search move magpie-search-mix:mix 1
```

The key field holds the sources in the order they are asked, joined by `+`. Each source is:

```text
<id>[=<key>[|<key>…]][@<base url>]
```

| Example | Meaning |
|---|---|
| `you` | You.com's free search |
| `tavily=tvly-a\|tvly-b` | Tavily with two keys, taking turns; a refused one rests |
| `searxng@https://searx.example.com` | your SearXNG |
| `tavily=tvly-a@https://relay.example.com/tavily` | Tavily at an address of your own, as magpie's `url=` |

Use `+` between sources, not spaces, commas or semicolons: magpie splits a key field at those into several keys and hands a search API one of them per search. If Search Mix is handed a single source, it says so in magpie's request log rather than search with it.

The keys stay in magpie's own key store, masked in its window. The plugin sends each key only to its own API, or to the address you set for that source. It reads no file of magpie's.

## Options

```sh
magpie plugin options magpie-search-mix '{"width": 3}'
```

| Option | Default | Meaning |
|---|---|---|
| `width` | `2` | how many sources are asked at once |
| `perSourceSeconds` | `10` | how long a source is waited for before the next one takes its place |
| `logDir` | none | a folder to log each search to (`search-mix.jsonl`): each source's time, pages or error. Never the query or a key |

## How many pages

magpie gives the agent a search API's pages up to the number the search asked for. Claude Code's WebSearch asks for 6; magpie's web-search MCP server for 1 to 20, 6 by default. So Search Mix mixes within that number. It can't hand over every page each source found: that needs a mix inside magpie, which [yetone/magpie#2845](https://github.com/yetone/magpie/issues/2845) asks for. Once magpie has one, you won't need this plugin.

In a small personal test of 60 questions, each with a known answer and official site, 6 pages were scored on whether they held the official site and the answer (120 points in all):

| 6 pages from | Score |
|---|---|
| DeepSeek and You.com, in turn | 111 |
| You.com alone | 108 |
| DeepSeek, You.com and Tavily, in turn | 108 |
| Tavily alone | 101 |
| DeepSeek alone | 94 |

With only 6 pages, a third source mostly pushes out good pages of the first two, which is why `width` is 2. Which API was best alone changed with the questions: Tavily on an earlier set of 20, You.com on these 60. Which two you mix matters too: Tavily and DeepSeek in turn scored 106 here. Your results will depend on your questions.

## Costs

Each search costs one search on every source asked: two by default, more when one gives its place to the next. Check each API's own pricing and free allowance.

## Development

```sh
bun test
SEARCH_MIX_SOURCES='you+tavily=tvly-…' bun scripts/try.js "a question"
```

`scripts/try.js` runs one search with real APIs and prints what each source did and the merged pages, never a key.

To add a search API, add an entry to `src/vendors.js` (how to ask it and how to read its reply) and tests to `test/vendors.test.js`.

## License

MIT. `test/fixtures/` holds example replies from magpie's own tests, under magpie's MIT License (see `test/fixtures/NOTICE.md`).
