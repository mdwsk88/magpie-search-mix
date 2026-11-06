# magpie 混合搜索插件（Search Mix）

[English](README.md)

给 [magpie](https://github.com/yetone/magpie) 加一个联网搜索 API：一次同时问两家（或更多）搜索 API，把它们找到的网页一起交给智能体。各家结果交替排列，几家都找到的同一网页只留一条。

这是 mdwsk88 写的非官方社区插件，不属于 magpie。

## 它做什么

把“混合搜索”排在 magpie「联网搜索」列表第一位后，智能体经 magpie 联网搜索时（Claude Code 的 WebSearch、Codex 的 web_search、magpie 的联网搜索 MCP 服务器）：

1. 同时问它的前两个来源；
2. 某个来源失败、没找到、超过 10 秒没回，或者它的密钥被拒后都在暂停期，就由下一个还没问过的来源顶上；
3. 交替取结果：先取各家的第 1 条，再取各家的第 2 条，依此类推。同一网页（按网址判断）只留一条，最多取这次搜索要的条数。

各家都没找到时返回空结果；各家都失败时报错。这两种情况 magpie 都会接着问列表里的下一个搜索 API，所以把你平时用的搜索 API 排在它后面做后备。

## 能混合的搜索 API

每家的调用和结果读取方式，都和 magpie 自己「联网搜索」列表里同一家的做法一致。

| 标识 | 搜索 API | 密钥 |
|---|---|---|
| `tavily` | Tavily | 需要 |
| `brave` | Brave Search | 需要 |
| `exa` | Exa | 需要 |
| `firecrawl` | Firecrawl | 需要 |
| `you` | You.com | 可选：不填用免费搜索（每个网络地址每天 100 次） |
| `deepseek` | DeepSeek 搜索 | 需要 |
| `volcengine` | 豆包搜索（火山引擎） | 需要 |
| `wsa` | 元宝搜索（腾讯云） | 需要 |
| `searxng` | SearXNG | 可选；需要它的地址 |

## 安装

```sh
magpie plugin add github:mdwsk88/magpie-search-mix
```

## 配置

在 magpie 的 **设置 › 模型 › 联网搜索** 里添加 **Search Mix (mdwsk88)**，排到第一位，在它的密钥栏里写上来源，用 `+` 连接：

```text
deepseek=sk-…+you+tavily=tvly-…
```

也可以用命令行：

```sh
magpie search add magpie-search-mix:mix 'deepseek=sk-…+you+tavily=tvly-…'
magpie search move magpie-search-mix:mix 1
```

密钥栏按提问顺序写来源，来源之间用 `+` 连接。每个来源的写法：

```text
<标识>[=<密钥>[|<密钥>…]][@<基础地址>]
```

| 例子 | 含义 |
|---|---|
| `you` | You.com 免费搜索 |
| `tavily=tvly-a\|tvly-b` | Tavily 两把密钥轮流用；被拒的那把先暂停 |
| `searxng@https://searx.example.com` | 你自己的 SearXNG |
| `tavily=tvly-a@https://relay.example.com/tavily` | 走你自己的地址访问 Tavily，同 magpie 的 `url=` |

来源之间要用 `+`，不要用空格、逗号或分号：magpie 会在这些地方把密钥栏拆成几把“密钥”，每次搜索只交给插件其中一段。插件如果只收到一个来源，会在 magpie 的请求日志里报错说明，而不会只用这一个来源去搜。

密钥仍由 magpie 保管，界面上打码显示。插件只把每把密钥发给它对应的搜索 API，或你为这个来源设置的地址，不读 magpie 的任何文件。

## 选项

```sh
magpie plugin options magpie-search-mix '{"width": 3}'
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `width` | `2` | 同时问几个来源 |
| `perSourceSeconds` | `10` | 每个来源最多等几秒，超时由下一个顶上 |
| `logDir` | 无 | 写日志的文件夹（`search-mix.jsonl`）：每个来源的用时、条数或错误；不记查询词和密钥 |

## 最多给几条

magpie 交给智能体的搜索结果，不会超过这次搜索要的条数：Claude Code 的 WebSearch 要 6 条，magpie 的联网搜索 MCP 服务器要 1–20 条（默认 6 条）。所以混合搜索只能在这个条数内混合，做不到把每家找到的全部结果都交出去。要做到这一点，得在 magpie 内部混合，[yetone/magpie#2845](https://github.com/yetone/magpie/issues/2845) 提的就是这个功能。magpie 有了它以后，就用不着这个插件了。

一次 60 题的小规模个人测试：每题都有已知答案和官方网站，看给出的 6 条结果里有没有官方网站、有没有答案（满分 120）：

| 6 条结果来自 | 得分 |
|---|---|
| DeepSeek 和 You.com 交替 | 111 |
| 只用 You.com | 108 |
| DeepSeek、You.com、Tavily 交替 | 108 |
| 只用 Tavily | 101 |
| 只用 DeepSeek | 94 |

只给 6 条时，加入第三家多半会把前两家的好结果挤掉，所以 `width` 默认是 2。单独用时哪家最好会随题目变化：之前一组 20 题是 Tavily，这 60 题是 You.com。混合哪两家也有影响：Tavily 和 DeepSeek 交替在这组题里只有 106 分。实际效果取决于你的问题。

## 费用

每次搜索会在每个被问到的来源各花一次：默认两家，某家失败由下一家顶上时会更多。请查看各家的价格和免费额度。

## 开发

```sh
bun test
SEARCH_MIX_SOURCES='you+tavily=tvly-…' bun scripts/try.js "一个问题"
```

`scripts/try.js` 用真实接口跑一次搜索，打印每个来源的情况和合并后的结果，不打印密钥。

要增加一个搜索 API，在 `src/vendors.js` 里加一项（怎么问、怎么读回复），并在 `test/vendors.test.js` 里补测试。

## 许可证

MIT。`test/fixtures/` 里是 magpie 自己测试用的示例回复，按 magpie 的 MIT 许可证使用（见 `test/fixtures/NOTICE.md`）。
