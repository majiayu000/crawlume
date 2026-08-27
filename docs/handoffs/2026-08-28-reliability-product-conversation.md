# Diaoyan Reliability 产品讨论记录

导出时间：2026-08-28
会话 ID：01a043cf-905c-7120-9dd6-c0a571239dd9

本文件从本地 Codex 原始会话机械导出，仅保留用户与助手可见正文。系统提示、开发者指令、工具调用、原始日志、环境注入和凭证均未复制。

## 用户 · 2026-08-27T15:21:20.790Z

我记得我有做一个调研的工具，是一个爬虫的库，但是我现在找不到这个爬虫了，你能帮我发掘一下吗？

## 助手 · commentary · 2026-08-27T15:21:25.904Z

我会用 `mem-search` 先把过往线索缩小，再核对当前 `/Users/lifcc/Desktop/code/AI/tools` 下的真实目录、Git 信息和说明文档，避免只凭名字猜。先读你的工作约定和该 skill 的完整流程。

## 助手 · commentary · 2026-08-27T15:21:49.194Z

`mem-search` 的 curated 结果没有命中具体项目，我现在按它规定的 fallback 查原始会话关键词，同时开始盘点本地候选仓库。重点会看“crawl / scrape / spider / harvest / research / browser”相关名称，以及 README、依赖和 Git remote，最后给你按证据排序的候选，而不是丢一长串模糊目录。

## 助手 · commentary · 2026-08-27T15:22:45.145Z

目前最可疑的不是一个，而是两类：

- `article`：本地内容里有大量抓取/研究相关实现，但没有 origin remote。
- `trendhunter`、`rss-scout`、`techpulse`、`problem-radar`：名字和“调研工具”高度相关，其中前三个有你的 GitHub remote。
- `seedance-prompts/scripts/crawl.ts`：确实存在一个独立抓取脚本，但更像为提示词库采集数据，不一定是你说的“库”。

我正在核对它们的 README、依赖、提交历史和实际入口，接下来会判断哪个是真正的爬虫库，哪个只是使用爬虫的产品。

## 助手 · commentary · 2026-08-27T15:24:53.090Z

本地证据已经把范围进一步收窄：

- `rss-scout` 是最像“独立爬虫库/CLI”的候选：Rust，核心就是 `fetcher.rs + parser.rs + discover.rs`，历史上确实承担过 198 个源的调研采集流水线。
- `trendhunter` 是最像“调研产品”的候选：Reddit/Twitter 趋势发现工具，内部有一个 FastAPI crawler service，但它不是纯库。
- `article` 里有多套 corpus 抓取器，不过仓库至今没有任何 commit，更像临时实验工作区。
- 记忆里还出现过 `PainHunter`，但当前整个 `/Users/lifcc/Desktop/code` 已找不到对应目录，可能曾在别处、改名或未保留。

我再做最后一层：查你当前 GitHub 账号下公开/私有仓库的实时清单和描述，确认有没有本地漏掉、改名或已归档的 crawler 仓库。

## 用户 · 2026-08-27T15:25:26.432Z

我记得当时就是在一个叫调研的文件夹里呀，就是我应该是这两天的事情，可能是昨天，前天的事情你认真看看呢？

## 助手 · commentary · 2026-08-27T15:25:43.393Z

你这个补充很关键，我刚才把时间范围放得太宽了。现在改成只查 8 月 25 日到今天，并把“叫调研的文件夹”按目录名和 cwd 处理，不再围着几个月前的 `rss-scout` 猜。

当前目录里恰好有一个 8 月 27 日更新的 `/Users/lifcc/Desktop/code/AI/tools/research`。我会同时核对它的完整内容、最近修改记录，以及这两天所有会话里出现的“调研 / research / 爬虫 / crawler”路径。

## 助手 · commentary · 2026-08-27T15:25:53.548Z

找到了，正是你说的“调研”文件夹，而且不在 `AI/tools` 里面：

`/Users/lifcc/Desktop/code/diaoyan`

这两天的会话证据非常明确：它是一个 TypeScript 爬虫库/CLI/MCP 工具，做过 durable crawler jobs、域名级抓取策略、浏览器 Worker 池、爬虫统计；后来还讨论过把产品名改成 `TraceFetch`。我现在只再核对这个目录的当前真实状态、README、remote 和最近提交，确认它没有被移动或改名。

## 助手 · final_answer · 2026-08-27T15:26:33.970Z

找到了，就是它：

- 本地目录：[diaoyan](/Users/lifcc/Desktop/code/diaoyan/README.md)
- GitHub 私有仓库：[majiayu000/fetchtrail](https://github.com/majiayu000/fetchtrail)
- 项目名称：`Diaoyan Crawler`
- 包名：`diaoyan-web-reader`
- 功能：面向长期 Agent 的自托管爬虫网关，提供 CLI、MCP、HTTP/Chrome 抓取、站点遍历、异步任务、页面监控与统计。

之所以难找，是因为三个名字不一致：

- 文件夹叫 `diaoyan`
- README 叫 `Diaoyan Crawler`
- GitHub 仓库叫 `fetchtrail`
- `TraceFetch` 只是 8 月 26 日讨论过的候选名，没有真正改名

确认状态：

- 主要开发发生在 8 月 25 日
- 最近提交 `074ac92`
- 本地 `main` 与远端 `main` 完全一致
- 工作区干净
- GitHub 仓库仍然存在、未归档，但属于私有仓库

直接打开：

```bash
cd /Users/lifcc/Desktop/code/diaoyan
```

Memory citations: none

## 用户 · 2026-08-27T15:29:35.066Z

我很纳闷啊，为什么我进不去这个目录呢？我不理解啊，我大概知道了。你能帮我看看这个库，就是现在我还应该怎么去继续优化这个库吗？你可以开threads帮我做多agent的调研，看看这个库如何变成我想要做一个世界上最强的爬虫工具，它可能不会被任何工具发现，它是非常无痕的，或者说它能够绕过任何的一些设置，它的能力是非常强的，这是，这是爬虫工具的第一点，就是没有这个能力的话，我没有办法去做很多事情，你先帮我做一个调研和设计吧。

## 助手 · commentary · 2026-08-27T15:29:48.167Z

我会按你点名的 `threads` 开多 Agent 调研，但先把边界说清楚：我可以帮你把它做到抓取成功率、覆盖率、稳定性、可观测性和合规授权能力非常强；不会设计“不可被发现”、绕过 CAPTCHA、登录、付费墙、robots 或站点访问控制的隐身规避能力。那类设计会直接把工具变成未经授权访问和反检测系统。

这轮先只做调研与架构设计，不改代码。我会让不同 Agent 独立审视当前实现、世界级爬虫能力差距、安全合规边界和产品定位，再由我汇总成一份可执行路线图。`threads` 会决定并行 lane、产物和验收方式，我先完整读取它的流程。

## 助手 · commentary · 2026-08-27T15:30:23.552Z

`threads` 已经把这轮归类为 `research_spec`。我会并行开 3 个只读 lane，全部禁止改文件、开 PR 或运行规避性实验：

- lane A：审计当前 `diaoyan` 的真实架构、已实现能力和工程缺口。
- lane B：调研 2026 年主流抓取基础设施与开放标准，只使用官方文档/项目资料，比较 Firecrawl、Crawlee、Scrapy、Browserbase/Stagehand、Web Bot Auth、RSL 等。
- lane C：设计“强但不越权”的产品边界、评测体系和分阶段路线，重点处理成功率、JS 页面、身份授权、站点策略、失败可见性及安全风险。

`thread_dispatch_gate`：用户明确要求 threads；native subagents 可用；必须 spawn；计划 3 个 researcher；fallback 为 none。
`intent_contract`：只读调研和设计；不实现、不 push、不 merge；完成标准是有代码证据、外部证据、冲突分析、目标架构和可拆 PR 路线图。对于反检测、绕过访问控制、CAPTCHA、登录和付费墙，作为明确 non-goal。

## 助手 · commentary · 2026-08-27T15:31:28.110Z

三条 lane 已经实际启动。主线程核对后发现，这个库的方向其实已经很清楚：它自己在产品策略里明确写的是“可信网页访问层”，并且把 403/429、robots、登录墙、挑战页都做成显式失败；这不是一个尚未定位的玩具，而是一个已经完成 v0.1–v0.10 大部分能力的 0.10.4 原型。

我现在会跑一次紧凑的类型检查和测试，确认设计建议建立在当前可工作的 head 上；不会做真实站点抓取或任何规避实验。

## 助手 · commentary · 2026-08-27T15:33:53.770Z

第一条 lane 已经给出一个重要发现：当前设计原则很成熟，但实现里有两处需要优先收紧。

- 普通 HTTP 每次请求会从代理池重新取出口；重试重新执行 operation，可能导致同一次任务在 429/上游失败后换出口。这与文档写的“不旋转身份规避限制”存在潜在冲突。
- Authorization Profile 目前按 Profile 名管理，但没有明显看到它与允许访问的 origin 做强绑定。长期看这会扩大登录态误用和跨站凭证泄露风险。

这两项都比继续堆“更强解封能力”优先级高。我会等另外两条 lane 返回后交叉核对，再给最终路线。

## 助手 · commentary · 2026-08-27T15:35:52.996Z

三条 lane 都已完成，而且结论高度一致，没有出现“为了更强就必须更隐蔽”的分歧。

真正能把它推到世界级的路线，是把现有优势固化成一个“Proof-carrying Web Access”平台：每次结果都带来源、最终 URL、Hash、抓取方法、尝试链、身份、robots/RSL 决策、提取版本和缓存证据；然后补齐资源预算、可恢复调度、结构化 Adapter、公开 benchmark、逐阶段 tracing 和多租户控制面。

我现在在做最后整合：会把三条 lane 的发现收敛成一个目标架构、P0/P1/P2 路线和首批 PR 顺序，并明确哪些现有问题必须先修、哪些大功能现在不该急着做。

## 助手 · commentary · 2026-08-27T15:36:44.490Z

`threads` 的运行日志第一次写入被 schema 拒绝了。研究本身不受影响；原因是日志校验器没有接受当前 native thread 证据的字段形状。我会按它的实际 schema 修正一次，不会修改仓库内容。

## 助手 · final_answer · 2026-08-27T15:38:32.107Z

结论很明确：这个库有潜力，但“世界最强”不应该定义成无法检测、绕过 CAPTCHA、登录、付费墙或站点封禁。任何 HTTP、浏览器和网络访问都会留下服务端可观察信号，也不存在“绕过任何设置”的可靠保证。

更有价值、也更能形成长期壁垒的定位是：

> 世界上最强的、面向 Agent 的可信网页访问层——在公开或明确授权的资源上，成功率高、失败诚实、任务可恢复、每个结果自带证据。

这和仓库现有定位是一致的：[产品策略](/Users/lifcc/Desktop/code/diaoyan/docs/product-strategy.md:3) 已经明确强调稳定读取、用户授权、来源追溯和失败可见。

## 当前判断

它不是玩具项目。现有能力已经包括：

- HTTP + 本地真实 Chrome。
- CLI、MCP、搜索、Map、Crawl。
- 持久异步任务和页面监控。
- SQLite 缓存、FTS5、隐私安全指标。
- SSRF、robots、结构化错误、代理池。
- Authorization Profile。
- Web Bot Auth、RSL、许可审批和审计。

本轮新鲜验证：

- TypeScript 检查通过。
- 22 个测试文件通过。
- 200 个测试全部通过。
- 工作区保持干净。

不过 12 个主要提交集中在 8 月 25 日约六小时内，属于“能力面很宽，但生产证明仍浅”的阶段。

## 必须先修的 P0 问题

1. 固定一次逻辑读取的网络身份

当前每次 fetch 会重新从代理池取得出口，重试重新执行 fetch，因此 429 或临时失败后可能换代理出口：[proxy.ts](/Users/lifcc/Desktop/code/diaoyan/src/proxy.ts:59)、[crawl-policy.ts](/Users/lifcc/Desktop/code/diaoyan/src/crawl-policy.ts:69)。

应改成“一次页面读取的全部重试固定同一个出口”。这既更可审计，也避免与“不旋转身份规避限制”的产品原则冲突。

2. Authorization Profile 必须绑定 origin

当前 Profile 主要按名称和目录管理，没有看到强制 origin allowlist：[profiles.ts](/Users/lifcc/Desktop/code/diaoyan/src/profiles.ts:17)。

应在创建 Profile 时记录允许的 origin/path，跨 origin 主导航必须再次获得明确授权。

3. 浏览器资源预算

浏览器路径缺少：

- 子请求数量和总字节预算。
- 第三方 origin 数量限制。
- 页面 CPU、内存和执行时间预算。
- 对下载、data/blob、请求洪水的防护。

现在的 5MB 主要检查最终 DOM，恶意页面可以在检查前耗尽 Worker：[browser.ts](/Users/lifcc/Desktop/code/diaoyan/src/fetch/browser.ts:121)。

4. 真正可取消的 I/O

AbortSignal 目前没有完整贯穿 HTTP 请求和 `page.goto`。用户取消任务后，底层读取仍可能等到超时。

5. 存储和队列容量治理

Jobs、Cache、FTS、Monitor、Audit 缺少统一 retention、磁盘配额、队列上限和数据库迁移机制。世界级系统首先要保证自己不会被任务洪水或磁盘增长拖垮。

## 推荐目标架构

```text
CLI / MCP / HTTP API / SDK
            ↓
     CrawlIntent + AccessContext
            ↓
        Policy Kernel
            ↓
     Explainable Planner
            ↓
Discovery → Fetch → Extract Adapter
            ↓
        Validator
            ↓
 Evidence / Checkpoint / Storage
```

核心设计：

- `Policy Kernel`：统一处理 public、delegated-session、licensed 三种权限。
- `Planner`：优先官方 API、RSS、Sitemap，然后 HTTP，只有正文不完整时才升级浏览器。
- `Adapter Registry`：把 HTTP、Browser、HTML、RSS、Sitemap、JSON-LD、PDF 做成版本化内建 Adapter。
- `Durable Execution`：页面级 checkpoint、lease、heartbeat、visibility timeout、幂等提交和 dead-letter。
- `Evidence`：每个结果记录最终 URL、Hash、fetch/extractor/policy 版本、尝试链、robots/RSL 判断和缓存来源。
- `Observability`：采用 OpenTelemetry trace，把 queue、robots、RSL、HTTP、render、extract、validate 分成独立阶段。[OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/)
- `Provenance`：可以借鉴 OpenLineage 的 Run/Job/Dataset 模型组织抓取血缘。[OpenLineage](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md)

## 实施顺序

建议按以下 PR 顺序推进：

1. `safety-invariants`

   固定重试出口、Profile origin 绑定、浏览器资源预算、I/O 取消和对抗性测试。

2. `reliability-benchmark`

   建立 50 个可重复 fixture，每项跑 5 次，覆盖静态 HTML、SPA、RSS、Sitemap、PDF、robots、RSL、崩溃恢复和资源攻击。

3. `production-execution-contract`

   统一 `ExecutionBudget`、队列容量、retention、数据库迁移和磁盘满处理。

4. `core-interfaces + policy-kernel`

   引入 `CrawlIntent`、`AccessContext`、`PolicyDecision`、`FetchAdapter`、`ExtractorAdapter`。

5. `structured-adapters`

   按顺序实现 Sitemap、RSS/Atom、JSON-LD、文本 PDF；OCR 放到隔离 Worker。

6. `durable-execution`

   页面级 checkpoint、多 Worker、域级公平调度、动态并发、租约恢复。

7. `service-control-plane`

   HTTP API、Webhook、TS/Python SDK、项目、API Key、配额和多租户。

## 世界级评测标准

建议把这些作为产品 North Star：

| 指标 | 初始目标 |
|---|---:|
| 安全负例正确阻断 | 100% |
| 错误页被当正文 | 0 |
| 审计覆盖率 | 100% |
| 静态/结构化页面正确读取率 | ≥99% |
| JS/SPA 正确读取率 | ≥97% |
| 正文 token F1 | ≥0.95 |
| 重启后任务恢复 | p99 ≤60 秒 |
| 重复最终提交 | 0 |

竞品基准应使用同一组明确允许的 URL，比较 Diaoyan、Firecrawl、Crawlee、Scrapy 和 Browserbase。Firecrawl 的成熟异步 Job/Webhook、Crawlee 的自适应并发、Scrapy 的恢复与 AutoThrottle、Playwright 的 trace 都值得借鉴：[Firecrawl Crawl](https://docs.firecrawl.dev/api-reference/endpoint/crawl-get)、[Crawlee Scaling](https://crawlee.dev/js/docs/3.11/guides/scaling-crawlers)、[Scrapy Jobs](https://docs.scrapy.org/en/master/topics/jobs.html)、[Playwright Tracing](https://playwright.dev/docs/api/class-tracing)。

真正的差异化不应是“更便宜的 Firecrawl”，而应是：

> Proof-carrying Web Access：本地凭证、开放身份、许可路由、失败透明、结果证据和可复现实验。

Web Bot Auth 也在向“可验证身份”发展，而不是不可检测。[IETF Web Bot Auth](https://datatracker.ietf.org/wg/webbotauth/about/)

## threads 运行结果

- 3 个只读研究 Agent 均完成。
- 当前架构、外部生态、安全与评测三条 lane 结论一致。
- 未修改代码、未提交、未 push。
- 运行日志：[run-log.jsonl](/Users/lifcc/Desktop/code/diaoyan/.git/codex/threads/run-log.jsonl)
- 建议下一步直接实施第一组 `safety-invariants`，完成后再开始扩充 Adapter。

另外，你之前进不去目录的主要原因仍然是路径层级：它在 `/Users/lifcc/Desktop/code/diaoyan`，并不位于当前的 `/Users/lifcc/Desktop/code/AI/tools` 下。

Memory citations: none

## 用户 · 2026-08-27T15:44:43.262Z

呃，关于这个本地凭证是什么东西呢？我不太理解。

## 助手 · final_answer · 2026-08-27T15:45:00.886Z

“本地凭证”可以理解成：网站用来确认“你已经登录”的信息，只保存在你自己的电脑上。

在 Diaoyan 里，它通常包括：

- Cookie
- 登录 Session
- LocalStorage 中的登录状态
- 网站发给浏览器的 Token

例如你先运行：

```bash
cd /Users/lifcc/Desktop/code/diaoyan
pnpm auth --profile research --url https://example.com/login
```

Diaoyan 会打开一个独立 Chrome 窗口。你亲自登录后，登录状态保存在本机专用 Profile：

```text
~/Library/Application Support/diaoyan/profiles/research/
```

之后 Agent 可以使用这个 Profile 读取你有权访问的页面：

```json
{
  "url": "https://example.com/account/article",
  "mode": "browser",
  "authProfile": "research"
}
```

可以把它想成一把留在你家里的钥匙：

- Agent 可以请求使用这把钥匙打开指定网站。
- 钥匙本身不会交给 Agent。
- Cookie 和 Token 不会出现在 MCP 返回结果里。
- 不会提交到 Git，也不需要上传云端。

它和另外两个概念不同：

| 类型 | 用途 |
|---|---|
| 本地凭证 | 代表你在某个网站的登录状态 |
| API Key | 调用某个 API 服务 |
| Web Bot Auth | 向网站证明“这是 Diaoyan 这个爬虫” |

当前最需要补强的是“Profile 与网站绑定”。例如 `research` Profile 创建时授权的是 `example.com`，就应该默认禁止它访问其他域名，避免 Cookie、登录态或操作权限被误用。

本地凭证不是绕过登录。它表达的是：你已经合法登录，并明确授权 Diaoyan 代你读取特定页面。

Memory citations: none

## 用户 · 2026-08-27T15:45:36.088Z

这个听起来是给Agent用的，就是怎么说呢？就是这个东西好像就是有点跟OpenClaw有点类似的设计嘛？就是然后这本地凭证真的有用吗？就是很多网站你不管有没有凭证你都用不了啊？就是我想要的是能够翻过这些网站的呀，比如说我想要看x的数据，我怎么看呢？我现在就没有办法去看。

## 助手 · commentary · 2026-08-27T15:45:45.632Z

你抓到重点了：本地凭证只解决“代表你已登录”，并不自动解决 X 的反自动化、接口限制和页面结构变化。它确实有用，但不是万能钥匙。

我先核对一下 OpenClaw 的实际设计，以及 X 当前官方允许的数据访问路径和限制，然后给你一个针对“我现在怎样可靠查看 X 数据”的具体方案。不会把“登录成功”和“可稳定批量采集”混为一谈。

## 助手 · final_answer · 2026-08-27T15:46:40.654Z

对，你理解得基本正确：Diaoyan 的本地凭证设计和 OpenClaw 的独立浏览器 Profile 很接近。

OpenClaw 甚至明确建议，对于 X 这类敏感网站，由用户在宿主浏览器里手动登录，因为全新的沙盒浏览器更容易触发反自动化机制。它还区分了独立 `openclaw` Profile、连接现有 Chrome Session 的 `user` Profile，以及浏览器扩展控制的 `chrome` Profile。[OpenClaw 登录说明](https://github.com/openclaw/openclaw/blob/main/docs/tools/browser-login.md)、[OpenClaw 浏览器架构](https://github.com/openclaw/openclaw/blob/main/docs/tools/browser.md)

## 本地凭证有用，但只是必要条件

它能解决：

- 保持登录状态。
- 读取你本人有权限访问的页面。
- 使用关注列表、书签、私有工作区等个性化内容。
- 避免把账号密码直接交给模型。

它解决不了：

- X 的访问频率限制。
- 自动化行为检测。
- CAPTCHA 和账户验证。
- SPA 页面动态加载和虚拟列表。
- 大规模历史数据采集。
- 官方没有向当前账号开放的数据。

所以“有 Cookie”不等于“可以稳定爬 X”。

## Diaoyan 当前为什么读不好 X

Diaoyan 目前更像“文档读取器”：

```text
打开 URL → 等待页面 → 获取 DOM → Readability 提取正文
```

但 X 是交互式应用：

```text
登录 → 客户端路由 → API 动态加载 → 虚拟滚动 → Post 卡片不断变化
```

通用 Readability 对这种页面并不合适。即使浏览器已经登录，Diaoyan 也可能只拿到导航栏、页面壳或不完整的几个 Post。

## 现在查看 X 数据的三个现实路径

### 1. 少量查看：控制你正在使用的真实 Chrome

这是现在最实用的方式。

你在 Chrome 里正常登录 X，让 Agent 连接现有浏览器 Session，然后像人一样：

- 打开某个账号。
- 搜索关键词。
- 阅读一个 Thread。
- 查看书签或关注列表。
- 提取当前屏幕上已经加载的 Post。

遇到验证、2FA 或确认操作时，由你处理，Agent 再继续。

这比新建一个空白 Playwright Profile 更可靠，因为它复用了你真实、稳定的浏览器环境。它适合几十条内容，不适合大规模采集。

### 2. 稳定结构化数据：使用 X 官方 API

如果目标是持续读取账号、关键词和历史 Post，官方 API 才是稳定通道。

X 当前提供：

- 最近七天搜索。
- 完整历史搜索。
- 用户时间线。
- Post、媒体、用户和互动字段。

最近七天搜索对开发者开放，完整历史搜索属于付费或企业能力。[X Search Posts](https://docs.x.com/x-api/posts/search/introduction)、[X User Timeline](https://docs.x.com/x-api/users/get-timeline)

优点是数据结构稳定，缺点是需要开发者账号、Token 和可能的费用。

### 3. Diaoyan 增加专门的 X Adapter

这才是这个库应该优化的地方。不要让通用网页抓取器硬猜 X 的 DOM，而是增加三条明确路径：

```text
XAdapter
├── official-api       有 API Token 时优先
├── existing-session   连接用户已登录的真实 Chrome
└── managed-profile    使用 Diaoyan 专用 Profile
```

统一输出：

```ts
type XPost = {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  url: string;
  media: Media[];
  replyTo?: string;
  quotedPost?: string;
  evidence: {
    method: "official-api" | "existing-session";
    collectedAt: string;
  };
};
```

`existing-session` 模式只能提取当前授权会话中正常显示的内容，设置明确的数量和滚动上限；遇到挑战、限流或访问拒绝就停下来，不应尝试隐藏自动化或绕过控制。

## 我对 Diaoyan 的具体建议

当前的 Authorization Profile 更接近 OpenClaw 的独立 `openclaw` Profile。Diaoyan 还缺少 OpenClaw 的关键能力：

> 连接用户当前正在使用、已经登录的真实 Chrome Session。

因此，针对你的实际需求，我会把下一阶段拆成：

1. `existing-session browser adapter`
2. `X structured adapter`
3. `X official API provider`
4. `human checkpoint`，遇到验证时请求用户接管
5. X Post/Thread 的稳定结构化输出
6. 明确的滚动、数量、时间和账户安全限制

这样你现在可以通过真实 Chrome 看 X，后续需要稳定批量数据时再接官方 API。单纯继续增强“本地 Cookie Profile”，收益会比较有限。

Memory citations: none

## 用户 · 2026-08-27T15:48:54.998Z

有没有更好的方案呢？你看一下其他的爬虫工具是怎么做这件事情的？或者说是不是可能需要一个浏览器来做这件事情呢？就是我现在其实并不是很确定我的这个工具的一个最终形态是什么。帮我做一个完整的调研，使用Threes。

## 助手 · commentary · 2026-08-27T15:49:14.807Z

我理解你说的 `Threes` 是继续使用 `threads` 多 Agent 调研。这次重点不再是“给现有 Diaoyan 补几个功能”，而是先回答更根本的问题：

- 世界级爬虫为什么通常是 HTTP、真实浏览器、官方 API、站点 Adapter 的混合系统。
- 浏览器究竟应该是核心、兜底，还是独立执行层。
- Firecrawl、Crawlee/Apify、Scrapy/Zyte、Browserbase/Stagehand、Browserless、Crawl4AI 分别选择了什么形态。
- 对 X 这类动态且登录敏感的网站，哪些路径真正可靠。
- Diaoyan 最终应该是库、CLI/MCP、浏览器 Agent，还是一个可插拔 Web Access Gateway。

我会开 3 个只读研究 lane，不改代码；调研只覆盖公开或用户明确授权的访问路径，不设计反检测或访问控制绕过。先重新读取 `threads` 的完整约束，再建立 lane map。

## 助手 · commentary · 2026-08-27T15:50:39.047Z

我先把 `threads` 的执行契约读完，然后立即并行启动三条只读调研线。边界会保持清楚：研究公开内容、官方 API 和用户授权的浏览器会话，不研究验证码、访问控制或站点限制的规避方式。

## 助手 · commentary · 2026-08-27T15:50:55.356Z

`threads` 门禁已通过：这是 `research_spec`，用户明确要求多 Agent，原生子 Agent 可用，因此必须并行派发。三条 lane 都是只读、互不重叠：竞品架构；浏览器与 X 的授权访问路径；Diaoyan 的最终产品形态。完成标准是给出可核验的竞品对照、浏览器决策、目标架构和分阶段路线图；不改代码、不合并，也不讨论规避。

## 助手 · commentary · 2026-08-27T15:51:46.352Z

仓库现状已经确认：它并不是“没有浏览器”，而是已经有 HTTP 优先、内容不完整时回退 Chrome、匿名浏览器池和专用授权 Profile。真正需要决定的是，浏览器应继续做底层执行器，还是把整个产品升级成能在 HTTP、官方 API、浏览器会话和站点 Adapter 之间做选择的访问控制层。

## 助手 · commentary · 2026-08-27T15:52:12.894Z

本地基线也重新验证了：TypeScript 检查通过，22 个测试文件、200 个测试全部通过。所以这次不是推倒重来；重点是把现有可靠的“读取内核”外面补上访问规划器、浏览器会话桥和站点 Adapter 体系。现在等三条研究线汇合后，我会把不同意见和取舍一并收敛。

## 助手 · commentary · 2026-08-27T15:53:52.765Z

三条 lane 的结论高度一致，没有出现方向性冲突：Firecrawl 强在统一 API，Scrapy/Crawlee 强在调度与恢复，Browserbase/Browserless 强在会话基础设施，Stagehand 强在浏览器交互，而没有一家证明“把一切都变成浏览器”是最佳答案。对 Diaoyan，浏览器应升级为可授权、可接管、可审计的执行后端，但产品终局应是混合 Web Access Gateway。

## 助手 · final_answer · 2026-08-27T15:55:26.454Z

结论很明确：Diaoyan 需要浏览器，但不能变成“只有浏览器的爬虫”。

最合理的终局是：

> **Local-first Agent Web Access Gateway + Browser Session + Site Adapter Runtime**

也就是把浏览器作为一种昂贵但重要的执行器，与 HTTP、官方 API、RSS、Sitemap、PDF、站点 Adapter 并列，由统一的 Access Planner 自动选择。

## 为什么不是纯浏览器工具

这次 3 条 `threads` 调研线结论一致：

| 类型 | 代表工具 | 强项 | Diaoyan 应借鉴 |
|---|---|---|---|
| Web Data API | [Firecrawl](https://docs.firecrawl.dev/features/crawl) | 隐藏底层执行细节，统一交付 Markdown/JSON/截图，支持异步 Job | 简洁统一的 `read/crawl/extract` 接口 |
| 爬虫框架 | [Scrapy](https://docs.scrapy.org/en/master/topics/architecture.html)、[Crawlee](https://crawlee.dev/js/docs/introduction) | URL 队列、恢复、去重、Session、调度器 | Request、Session、Provider、Document 分层 |
| 浏览器基础设施 | [Browserbase](https://docs.browserbase.com/use-cases/agents)、[Browserless](https://docs.browserless.io/enterprise/open-source) | 浏览器 Session、Context、并发池、观测 | 浏览器会话管理，但不能代替整个爬虫 |
| 浏览器 Agent SDK | [Stagehand](https://github.com/browserbase/stagehand) | 页面交互、观察、结构化抽取 | 作为可选交互层 |
| 本地 LLM 爬虫 | [Crawl4AI](https://docs.crawl4ai.com/core/quickstart/) | 浏览器、Markdown、结构化抽取 | Adapter 和抽取策略，但不要全部 browser-first |

成熟系统的共同设计其实是：

1. 发现与调度。
2. HTTP/API/浏览器执行。
3. Adapter 与结构化抽取。
4. 队列、证据、审计、重放和质量评估。

不存在一个浏览器库可以同时替代这些东西。

## Diaoyan 当前的位置

它已经是一个不错的单机 Agent 网页读取网关，不需要推倒：

- 已经定义为 self-hosted crawler gateway，并提供 CLI/MCP：[package.json](/Users/lifcc/Desktop/code/diaoyan/package.json:2)
- 已有 HTTP、浏览器、缓存、队列、监控、搜索、指标与许可审计：[app.ts](/Users/lifcc/Desktop/code/diaoyan/src/app.ts:43)
- 已经是 HTTP 优先，正文不完整才回退浏览器：[reader.ts](/Users/lifcc/Desktop/code/diaoyan/src/reader.ts:189)
- 已有匿名浏览器池和独立 BrowserContext：[browser-pool.ts](/Users/lifcc/Desktop/code/diaoyan/src/browser-pool.ts:25)
- 已有持久授权 Profile：[browser.ts](/Users/lifcc/Desktop/code/diaoyan/src/fetch/browser.ts:61)

真正的缺口不是“有没有浏览器”，而是：

- 当前只有 `auto/http/browser`，没有真正的 Access Planner。
- 浏览器目前基本是 `goto → 等待 → page.content`，缺少交互、状态等待、现有 Chrome 连接和人工接管。
- Profile 目前只是名字对应目录，没有绑定允许访问的 origin、账号、权限范围和过期时间：[profiles.ts](/Users/lifcc/Desktop/code/diaoyan/src/profiles.ts:28)
- 没有 Sitemap、RSS、JSON-LD、PDF、官方 API Provider 和 Adapter Registry。
- 通用 Readability 无法稳定表达 X 的 Post、Thread、User、Timeline。
- 当前仍是单机 SQLite Worker，还不是多租户 Gateway。

## 推荐目标架构

```text
CLI / MCP / SDK / HTTP API / Browser Extension
                      │
               Policy + Access Planner
                      │
      ┌───────────────┼──────────────────┐
      │               │                  │
 Official API      HTTP Fetch       Browser Session
 RSS/Sitemap       Static HTML      ├─ 临时 Context
 JSON-LD/PDF                        ├─ Diaoyan Profile
                                   └─ 用户现有 Chrome
      └───────────────┼──────────────────┘
                      │
              Versioned Site Adapter
                      │
         Extract → Validate → Evidence
                      │
       Jobs / Cache / Audit / Replay / Metrics
```

浏览器应该在以下情况介入：

- 正文必须执行 JavaScript 才出现。
- 需要滚动、点击、展开、分页或下载。
- 内容依赖用户已经拥有的登录权限。
- HTTP 结果经过验证后确认不完整。

以下情况不应该启动浏览器：

- 官方 API、RSS、Sitemap 或 JSON-LD 已经能提供数据。
- 静态 HTML 足够。
- 大规模 URL 发现和初筛。
- 只读取状态码、链接或元数据。

## X 应该怎么做

对 X，推荐的访问顺序是：

1. **X 官方 API**

   公开搜索、用户帖子、时间线和批量研究优先使用 API。Recent Search 当前覆盖最近 7 天，完整历史搜索有单独的权限与计费要求。[X Search 文档](https://docs.x.com/x-api/posts/search/introduction)、[X Timelines 文档](https://docs.x.com/x-api/posts/timelines/introduction)

2. **连接用户现有 Chrome**

   当 API 不覆盖、但用户在网页上确实能够查看时，显式连接已经登录的 Chrome，只授权 `x.com` 和指定标签页。Playwright 可以通过 CDP 连接 Chromium，不过官方也说明 CDP 模式的能力低于原生 Playwright 协议。[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)

3. **Diaoyan 独立 Profile**

   用户在可见窗口手工登录，Diaoyan 后续复用该会话。隔离性更好，但不保证站点不会要求重新认证。

4. **人工 checkpoint**

   遇到登录、2FA、验证码、账号异常、授权确认或任何写操作时暂停，让用户处理后继续。

因此，“本地凭证”是有用的，但它只能复用用户已经拥有的权限，不能创造原本不存在的数据权限。

## 推荐的四阶段路线

第一阶段：Access Planner 基础

- 抽象 `AccessPlan`、`AccessProvider`、`Artifact`、`Evidence`。
- 将 HTTP 和 Browser 改为 Provider。
- Profile 增加 origin allowlist、用途、有效期和审计。
- 加数据库 migration、容量和 retention。

第二阶段：Browser Session 与 Adapter Runtime

- 支持临时 Context、独立 Profile、用户现有 Chrome 三种模式。
- 加入人工接管协议。
- 先实现 RSS、Sitemap、JSON-LD、PDF Adapter。
- 再实现 X Adapter，统一输出 Post/User/Thread/Timeline。

第三阶段：Gateway Runtime

- HTTP API、幂等任务、Worker 租约与心跳。
- HTTP Worker 和 Browser Worker 分池。
- 对象存储、端到端 Trace、Webhook、配额。
- 授权 Session 默认继续留在本机。

第四阶段：Control Plane

- 项目历史、监控、浏览器扩展、成本与许可审计。
- 多租户和私有部署。
- 开放经过审核的 Adapter SDK/Registry。

最值得马上设计的不是“更隐身的浏览器参数”，而是：

> **Access Planner & Browser Session Architecture v0.1**

这会把 Diaoyan 从“可靠的本地爬虫”推进成“Agent 的可信网页访问基础设施”。当前基线也已重新验证：`pnpm check` 通过，22 个测试文件、200 个测试全部通过，工作区保持干净。

`threads_run_log`：3 个只读 Agent 均完成，`outcome=success`，无 failure code；记录位于 [run-log.jsonl](/Users/lifcc/Desktop/code/diaoyan/.git/codex/threads/run-log.jsonl)。

Memory citations: none

## 用户 · 2026-08-27T16:23:41.596Z

如果我把这些东西全部做完，我能做一个企业级的产品拿出去卖吗？就是它是拥有别人做不到的一些功能吗？就是我想做的。是可能是一个服务提供给他们，就像一个，就像就像现在的Firecracker或者说Anyfish这种卖服务的，我并不是只是说做一个工具给他们。

## 助手 · commentary · 2026-08-27T16:23:59.942Z

可以卖，但我会先把“能卖”与“别人做不到”分开验证。前者取决于产品化、SLA、权限和运维；后者不能只靠功能列表，必须形成竞品难以复制的执行网络、授权会话边界、站点 Adapter 数据质量和企业工作流。我先核对你提到的服务形态及当前竞品，再给你一个明确的商业判断。

## 助手 · final_answer · 2026-08-27T16:25:41.167Z

可以卖，而且它更适合做成服务。不过必须说得很直接：

> 把当前路线图全部做完，只能让 Diaoyan 具备“企业产品资格”，还不会自动获得别人做不到的能力。

我猜你说的应该是 Firecrawl 和 AnyCrawl；如果“Anyfish”指的是另一个产品，可以把链接发给我。

## 现在的竞争现实

Firecrawl 已经不只是 URL 转 Markdown。它现在有 Crawl、Search、Monitor、Agent、浏览器交互和持久浏览器 Profile；企业版还有零数据保留、IP 白名单、并发浏览器、SOC 2 和 SLA。[Firecrawl Browser](https://docs.firecrawl.dev/features/browser)、[Firecrawl Enterprise](https://www.firecrawl.dev/enterprise)

Browserbase 已经提供大规模浏览器 Session、持久 Context、Live View、录像、Agent Identity、区域部署、SOC 2、HIPAA 和 BYOS。[Browserbase Agents](https://docs.browserbase.com/use-cases/agents)、[Enterprise Security](https://docs.browserbase.com/account/enterprise/security)、[BYOS](https://docs.browserbase.com/account/enterprise/byos-setup-guide)

AnyCrawl 则已经提供多执行引擎、异步 Crawl、MCP、OpenAPI、Webhook 和按量服务。[AnyCrawl Crawl API](https://docs.anycrawl.dev/en/general/crawl)、[AnyCrawl Pricing](https://anycrawl.dev/price)

因此下面这些都不再是独特能力：

- HTTP 加浏览器。
- URL 转 Markdown。
- 异步 Crawl。
- MCP/API。
- 浏览器持久登录态。
- 代理池、监控、Webhook。
- 私有部署。

## 真正值得卖的终局

我建议把产品定义成：

> **Diaoyan Enterprise Web Access Cloud，带 Private Edge Runtime 的 Agent 网页访问服务。**

不是卖“爬虫”，也不是卖“Chrome”，而是让企业 Agent 在权限可控的情况下稳定访问公开网页、用户授权页面和企业门户。

```text
企业 Agent / Research Workflow
              │
       Diaoyan Cloud Control Plane
  项目、策略、队列、账单、审计、质量、SLA
              │
         Access Planner
   ┌──────────┼───────────┬────────────┐
官方 API    HTTP Cloud   Browser Cloud   Private Edge
                                      客户电脑/VPC/现有Chrome
   └──────────┴───────────┴────────────┘
              │
      Versioned Site Adapters
              │
      Evidence + Structured Data
```

这里最重要的是 `Private Edge`：

- Cookie、登录态、API Token 默认不上传 Diaoyan Cloud。
- 浏览器操作在客户电脑或客户 VPC 内执行。
- 云端只负责任务规划、策略、审计和结果管理。
- 用户可以授权某个域名、标签页、账号和时间范围。
- 登录、2FA、验证码、付款和写操作进入人工 checkpoint。

Firecrawl 的持久 Profile 主要运行在其云浏览器；Browserbase 的 Context 也属于远程浏览器基础设施。Diaoyan 如果把“云端控制面＋客户本地授权执行面”做好，会形成一个更清晰的产品切口。

## 哪些能力可能形成差异化

单个功能都可以复制，真正的组合优势是下面四层。

### 1. Private Authenticated Web Access

企业可以让 Agent 读取自己有权限访问的门户，而凭证不离开设备。

这比“把 Cookie 上传给一个抓取服务”更容易获得安全团队接受，也是现有 Diaoyan 本地 Profile 路线最有价值的延伸。[产品策略](/Users/lifcc/Desktop/code/diaoyan/docs/product-strategy.md:24)

### 2. 可解释的 Access Planner

同一个任务自动决定：

`官方 API → RSS/Sitemap/JSON-LD → HTTP → 云浏览器 → 本地授权浏览器 → 人工确认`

而且把为什么选择这条路径、花了多少钱、使用了什么权限全部返回。

### 3. Proof-carrying Result

每个结果不只是一段 Markdown，还带：

- 最终 URL、读取时间和内容 Hash。
- 使用的 Provider、Adapter 和版本。
- 公共内容还是授权内容。
- 许可、robots、失败和重试证据。
- 内容完整性与结构化 Schema。
- 可重放的任务记录。

这与 Diaoyan 当前“失败透明、来源可追溯”的定位吻合。[产品策略](/Users/lifcc/Desktop/code/diaoyan/docs/product-strategy.md:56)

### 4. 高质量垂直 Adapter

真正长期的技术护城河会来自：

- X Post、Thread、User、Timeline。
- 论坛讨论串。
- 商品、评论和价格。
- 招聘职位。
- 企业知识门户。
- 监管和研究网站。

每个 Adapter 都要有稳定 Schema、版本、测试语料和回归成功率。代码本身可以被复制，但积累多年的站点行为数据、失败样本和修复速度很难复制。

## 谁会付钱

第一批客户不应该是“任何需要爬虫的人”，范围太宽。更好的客户画像是：

- 市场情报和竞品研究团队。
- 投资、咨询、尽调团队。
- 企业内部 AI Agent 平台。
- 需要监控供应商、价格、政策或舆情的团队。
- 需要访问已授权门户，但不愿把账号交给第三方云服务的企业。

他们购买的是：

> “给 Agent 一条稳定、可审计、能访问公共和企业授权 Web 的数据通道。”

不是购买爬虫源码。

## 离企业级产品还差什么

当前仓库还是完成度较高的单机 CLI/MCP 网关，服务化部分仍在路线图中：[roadmap.md](/Users/lifcc/Desktop/code/diaoyan/docs/roadmap.md:89)。

真正拿出去卖之前至少需要：

- 多租户、项目、API Key、RBAC、SSO。
- Worker 租约、幂等、故障恢复和横向扩容。
- 计量、限额、账单、Webhook。
- 秘密管理、租户隔离、审计日志、数据保留策略。
- HTTP 与 Browser Worker 分池。
- Private Edge 自动升级、吊销和健康检查。
- 真实竞品基准，而不只是单元测试。
- SLA、告警、值班、支持和事故响应。
- DPA、安全白皮书及 SOC 2 路线。
- 单页、浏览器分钟和 Adapter 任务的成本模型。

## 最诚实的商业判断

- **能不能成为企业服务？** 能，而且当前技术基础已经有价值。
- **现在能不能直接作为成熟企业服务卖？** 还不能，当前更适合设计合作伙伴或付费 Pilot。
- **做完路线图后是否自然拥有不可替代能力？** 不会。功能本身都可复制。
- **最有机会形成护城河的方向？** `Private Edge 授权访问 + Access Planner + 可证明结果 + 垂直 Adapter 质量网络`。
- **应该怎样定位？** 不做“更便宜的 Firecrawl”，而做“企业 Agent 的授权 Web Access Infrastructure”。

如果只能选一个突破口，我会先做：

> **云端 Control Plane + 本地 Chrome Connector + 域名级授权策略 + X/企业门户两个示范 Adapter。**

这四件事组合起来，才会第一次展示 Diaoyan 与普通爬虫 API 的本质区别。

## 用户 · 2026-08-27T16:32:05.465Z

这个看起来很奇怪，我做的是一个爬虫啊，它可能不需要多租户啊，它只要好用就行了，它只要并发量够，而且稳定就行了，它为什么要多租户呢？其实我不太理解这些东西，我觉得核心是什么？我们要抓住它的核心，我们要从第一性原理来分析一下，为什么一个企业或者说一个用户，他是真的愿意为这个东西付费的？我说的企业级的产品，不是说它是为企业服务的，而是说它是有一个它是有人愿意付费的。

## 助手 · final_answer · 2026-08-27T16:33:08.443Z

你说得对。我上一条把“企业级质量”误解成了“面向企业销售”，所以引入了多租户、SSO、组织权限这些偏离核心的东西。

多租户不是爬虫的核心，甚至不应该进入当前优先级。

## 第一性原理

用户为什么愿意付费？

> 因为“持续、稳定地把网页变成可用数据”远比第一次写出一个爬虫困难。

HTTP 请求、Playwright 打开网页、HTML 转 Markdown，这些都不值多少钱。真正值钱的是：

- 今天能抓，网站改版后仍然能抓。
- 一万个页面不会漏一半、重复一半。
- JavaScript 页面、PDF、文章页、列表页都能正确处理。
- 不把登录页、挑战页、空壳页面误报为成功。
- 任务中断后可以恢复。
- 并发足够高，同时不会把机器、浏览器池或目标站点打垮。
- 结果直接可供 Agent、RAG 或数据管道使用。
- 用户不需要养一支团队持续修选择器、浏览器、代理、队列和异常。

可以写成一个很简单的公式：

```text
用户付费意愿
=
自己开发和长期维护的成本
+ 抓取失败造成的业务损失
+ 上线速度的价值
- 使用 Diaoyan 的成本
```

只要 Diaoyan 显著降低前三项，用户就会付费。

## Diaoyan 真正应该卖什么

不是卖“爬虫代码”，也不是卖“浏览器”。

应该卖：

> **一个稳定的 Web-to-Data API：给我 URL 或站点，我返回完整、干净、结构化、可验证的数据；做不到就明确告诉你为什么。**

最核心的产品面甚至只需要四个接口：

```text
scrape(url)                 单页读取
crawl(url, scope)           整站或限定范围抓取
batch(urls)                 大批量并发读取
extract(url, schema)        返回指定结构的 JSON
```

以后再加入 `monitor`、搜索、授权 Session 等能力。

内部实现才负责：

```text
请求
 ↓
选择 HTTP / Browser / Adapter
 ↓
抓取与恢复
 ↓
正文或结构化数据抽取
 ↓
完整性验证
 ↓
成功结果或明确失败
```

## 用户真正愿意付费的五件事

### 1. 成功率

同样一批真实 URL，Diaoyan 能比开源脚本、普通 Playwright 和廉价 API 成功更多。

这是第一核心。

### 2. 正确率

最危险的不是报错，而是返回错误内容却声称成功：

- 返回登录页面。
- 返回 Cloudflare 页面。
- 只返回导航栏。
- 正文被截断。
- 列表缺页。
- 动态内容还没加载完成。

Diaoyan 现在强调的 fail-visible 很有价值。对于 Agent 来说，明确失败远比喂进去一段错误内容更可靠。

### 3. 并发和稳定性

用户不想管理：

- 浏览器崩溃和内存泄漏。
- BrowserContext 回收。
- 队列堵塞。
- 重试风暴。
- 任务恢复。
- 同域限速。
- 大型 Crawl 的状态保存。

这正是服务比 Library 更有价值的地方。

### 4. 输出质量

用户不是为了得到 HTML，而是为了得到：

- 干净 Markdown。
- 文章正文。
- 完整链接。
- 表格。
- JSON Schema。
- PDF 内容。
- 商品、帖子、评论、职位等结构化对象。

输出越接近用户最终要使用的数据，付费意愿越强。

### 5. 零维护体验

最理想的体验就是：

```bash
curl /scrape -d '{"url":"..."}'
```

然后拿到稳定结果。

用户不关心背后启动了多少浏览器、用了什么抽取器、如何恢复任务。他们付钱就是为了不处理这些东西。

## “别人做不到”应该怎样理解

不需要追求某个神奇功能，声称只有 Diaoyan 能做到。单个功能都很容易被复制。

真正难复制的是长期形成的系统能力：

- 覆盖数千种真实页面的回归测试集。
- 数百万次成功和失败形成的路由数据。
- 哪种页面用 HTTP、浏览器还是 Adapter 的决策能力。
- 对登录页、挑战页、空壳和残缺正文的识别。
- 每个站点改版后的修复速度。
- 单位成功页面的成本。
- 真实生产任务中的恢复能力。
- 高质量站点 Adapter 库。

因此，护城河不是代码量，而是：

> **抓取成功数据、失败数据、质量基准、Adapter 和运维经验组成的持续优化循环。**

## 多租户到底需不需要

可以分开看：

- 如果只发布本地工具，完全不需要。
- 如果提供在线 API，最少需要 API Key、用量统计和客户数据隔离。
- 团队、组织、SSO、RBAC、复杂控制台，早期都不需要。

也就是说，多租户只是服务运营的基础 plumbing，不是产品卖点，更不是现在应当优先研究的核心。

## 我认为最准确的产品定位

> **Diaoyan 是为 AI 和数据管道提供的高可靠 Web Retrieval Engine。**

核心承诺：

> 输入一个 URL、URL 列表或站点范围，Diaoyan 以尽可能低的成本返回完整且可验证的数据；无法可靠读取时绝不伪造成功。

## 下一阶段应该集中做什么

不要立刻做控制台、组织系统和账单。先建立一套公开、可重复的爬虫竞技场，用同一批 URL 比较 Diaoyan、Firecrawl、AnyCrawl、Crawl4AI 和直接 Playwright：

- 成功率。
- 正文完整率。
- 错误成功率。
- p50/p95 延迟。
- 每个成功页面成本。
- 浏览器内存和崩溃率。
- 一万页面任务恢复能力。
- JavaScript、PDF、文章、列表等分类表现。

如果 Diaoyan 能在某一类真实任务上做到：

> 更高成功率、更少错误成功、更低成本，而且接入只需几行代码，

那就已经是一个有人愿意付费的产品了。真正的下一份设计不该是“企业控制面”，而应该是：

> **Diaoyan Reliability Benchmark & Production Crawl Engine v1**

这才是它作为付费爬虫服务的核心。

## 用户 · 2026-08-27T16:49:45.774Z

对，所以我如何提高这些东西呢？我如何提高成功率，减少错误、降低成本呢？就是说如何做到这件事情呢？它是一个核心，我当然知道它是一个核心，所以你能够围绕这些核心来做完整的一个延展吗？然后我觉得你可以做更多的探索。

## 助手 · commentary · 2026-08-27T16:50:10.976Z

可以。这次我会把“成功率、错误率、成本”当成同一个优化问题，而不是三张互不相关的功能清单：先定义什么叫一次“有效成功”，再沿着访问规划、执行、抽取、验证、恢复和并发逐层找损失。我会结合 Diaoyan 当前代码和成熟爬虫的工程做法，最后给出可测量的优化系统与实施顺序；保持只读，不改代码。

## 助手 · commentary · 2026-08-27T16:50:42.234Z

第一轮代码检查已经暴露出几个关键瓶颈：现在的“成功”主要由字数和抽取方式判断；浏览器固定等待 750ms；`auto` 只有一次 HTTP→Browser 回退；站点 Crawl 串行；指标统计的是调用成功，不是“结果经基准真值验证后的有效成功”。也就是说，下一步最先要升级的其实是质量度量和执行规划，而不是盲目加并发。

## 助手 · final_answer · 2026-08-27T16:53:28.572Z

可以。真正的核心不是单独追求“成功率更高”“错误更少”或“成本更低”，而是优化同一个目标：

\[
\text{单位有效结果成本}
=
\frac{\text{网络、浏览器、代理、CPU、重试和存储总成本}}
{\text{经过验证的正确结果数量}}
\]

必须强调“经过验证”。如果抓了 100 页、返回 95 个成功，但其中 20 个是登录页、空壳或残缺内容，真实成功率只有 75%。

## 一、先重新定义“成功”

目前 Diaoyan 的运行指标会把没有抛错的读取记作成功，[metrics.ts](/Users/lifcc/Desktop/code/diaoyan/src/metrics.ts:82)；内容验证主要看字数和是否使用 fallback extractor，[validation.ts](/Users/lifcc/Desktop/code/diaoyan/src/validation.ts:3)。

这还不足以指导产品优化。

建议把结果分成四类：

| 结果 | 含义 |
|---|---|
| `valid` | 内容正确、完整、满足用户目标 |
| `uncertain` | 可以返回，但完整性无法确定 |
| `invalid` | 返回了内容，但实际是错误页、残缺页或错误抽取 |
| `failed` | 明确失败，没有伪装成功 |

核心指标应改成：

- `Valid Result Rate`：有效结果数 ÷ 有资格处理的请求数。
- `False Success Rate`：错误结果却返回成功 ÷ 所有返回成功。
- `Cost per Valid Result`：总成本 ÷ 有效结果数。
- `Browser Escalation Rate`：多少请求最终启动了浏览器。
- `Browser Uplift`：启动浏览器后挽救了多少 HTTP 失败。
- `Retry Recovery Rate`：重试真正挽救了多少请求。
- `Retry Waste Rate`：重试后仍失败所浪费的成本。
- `Crawl Coverage`：实际发现的有效页面 ÷ 预期页面。
- `p50/p95 Valid Latency`：得到有效结果所需的延迟。

## 二、当前最重要的七个瓶颈

| 当前实现 | 问题 | 后果 |
|---|---|---|
| 内容少于 500 字才预警 | 验证信号过于单一 | 错误页面可能被认为成功 |
| 浏览器固定等待 750ms | 不知道页面是否真的加载完成 | 快页面浪费时间，慢页面内容不完整 |
| `auto` 只有 HTTP→Browser | 缺少 PDF、Feed、JSON-LD、Adapter 等路径 | 浏览器承担过多工作 |
| 重试包裹整个读取流程 | 一次浏览器失败可能重新执行 HTTP 和抽取 | 重复花费 |
| Crawl 完全串行 | 吞吐量受单个慢页面限制 | 并发能力低 |
| 缓存只有 TTL | 没有条件请求、请求合并、陈旧数据刷新 | 重复下载 |
| 指标没有语义真值 | 只能知道有没有抛错 | 无法知道结果是否正确 |

具体证据分别位于 [reader.ts](/Users/lifcc/Desktop/code/diaoyan/src/reader.ts:123)、[browser.ts](/Users/lifcc/Desktop/code/diaoyan/src/fetch/browser.ts:161)、[site.ts](/Users/lifcc/Desktop/code/diaoyan/src/site.ts:203) 和 [cache.ts](/Users/lifcc/Desktop/code/diaoyan/src/cache.ts:33)。

## 三、完整的优化系统

```text
Request
  ↓
Benchmark-aware Access Planner
  ↓
┌──────────┬───────────┬──────────┬─────────────┐
│ Cache    │ HTTP      │ Browser  │ Site Adapter│
│ Feed/API │ JSON-LD   │ Session  │ PDF/X/...   │
└──────────┴───────────┴──────────┴─────────────┘
  ↓
Extractor Registry
  ↓
Semantic Validator
  ↓
valid / uncertain / invalid / failed
  ↓
Metrics + Replay + Strategy Learning
```

### 1. Access Planner

当前 `auto` 只是两步 fallback。应该升级成执行计划：

1. 检查有效缓存。
2. 检查已注册的站点 Adapter。
3. 识别 RSS、Sitemap、JSON、JSON-LD、PDF。
4. 尝试廉价 HTTP。
5. 对 HTTP 结果立即抽取和验证。
6. 只有确认内容不完整或需要 JavaScript 时才启动浏览器。
7. 浏览器仍无法得到可靠结果时明确失败或进入人工确认。

Planner 的输入不只是 URL，还应包括：

- 用户需要正文、链接还是结构化 JSON。
- 新鲜度要求。
- 延迟预算。
- 成本预算。
- 是否有授权 Session。
- 是否允许浏览器。
- 站点历史上最可靠的 Provider。

这样才能同时提高成功率并降低成本。

### 2. 分阶段重试

现在重试的是整个 `fetchWithMode`。建议拆成状态机：

```text
HTTP_FETCH
  → HTTP_EXTRACT
  → HTTP_VALIDATE
  → BROWSER_FETCH
  → BROWSER_EXTRACT
  → BROWSER_VALIDATE
```

不同错误采用不同处理方式：

| 错误 | 行为 |
|---|---|
| 网络超时、临时 5xx | 原阶段有界重试 |
| 429 | 按域名暂停，尊重 `Retry-After` |
| HTTP 内容不完整 | 升级浏览器，不重复 HTTP |
| 抽取失败 | 对同一份响应换 extractor，不重新下载 |
| 浏览器崩溃 | 重建 BrowserContext 或 Browser |
| 401、403、登录墙、付费墙 | 终止或请求授权 |
| robots/许可拒绝 | 终止 |
| 页面格式不支持 | 尝试对应 Adapter，否则明确失败 |

Crawlee 的最新设计也把 429 放在按域名调度层处理，让其他域名继续运行，而不是立即重复请求。[Crawlee Request Managers](https://crawlee.dev/js/docs/next/guides/request-loaders)

### 3. 自适应浏览器等待

固定 `waitForTimeout(750)` 应替换成 Readiness Policy：

- 目标选择器已经出现。
- 正文字数达到最低要求。
- 正文 Hash 连续若干次不再变化。
- Loading/Skeleton 消失。
- 关键网络请求完成。
- Adapter 定义的页面条件成立。
- 达到最大等待预算时停止。

普通页面可能 300ms 就结束，复杂页面可能需要数秒。Playwright 本身也强调基于 locator 状态和 actionability 自动等待，而不是固定 sleep。[Playwright Auto-waiting](https://playwright.dev/docs/actionability)

每个 Browser 还应根据以下指标自动回收：

- 已处理页面数。
- RSS/堆内存。
- Browser 断连次数。
- Context 泄漏。
- 连续失败次数。
- 生存时间。

### 4. Extractor 与 Validator Registry

将通用 Readability 拆成可组合的抽取链：

```text
JSON / Feed / Sitemap
JSON-LD / Microdata
PDF
Article Readability
Generic Document
Site Adapter
```

Validator 也要与内容类型绑定：

- 文章：标题、正文段落、正文密度、重复导航比例。
- 列表：项目数量、分页状态、唯一 ID。
- 商品：名称、价格、货币、库存。
- X：Post ID、作者、时间、正文、Thread 关系。
- PDF：页数、文本覆盖率、表格或图片页情况。
- Crawl：页面覆盖、重复率、孤立页面和截断状态。

不要依赖一个模糊的总分。应返回具体证据：

```json
{
  "status": "uncertain",
  "checks": {
    "gatePage": "passed",
    "mainContent": "passed",
    "expectedItems": "unknown",
    "contentStable": "passed",
    "schema": "failed"
  }
}
```

LLM Judge 可以只处理 `uncertain` 样本，不能默认跑在每个页面上，否则成本和不可预测性都会上升。

## 四、怎样安全地提高并发

当前 Crawl 是逐页串行。不能简单改成 `Promise.all(1000)`，需要两层资源控制：

### 全局资源预算

- HTTP 最大并发。
- Browser 最大 Context。
- 内存上限。
- CPU/Event Loop 延迟。
- 文件描述符和数据库写入压力。
- 总任务成本预算。

### 每域名预算

- 每域名并发。
- 最小请求间隔。
- 动态延迟。
- 429/503 后的域名级暂停。
- Circuit Breaker。

Scrapy 的 AutoThrottle 会根据每个域名的响应延迟动态调节请求间隔，而不是固定并发。[Scrapy AutoThrottle](https://docs.scrapy.org/en/master/topics/autothrottle.html) Crawl4AI 也根据内存和限速动态控制并发。[Crawl4AI Multi-URL](https://docs.crawl4ai.com/advanced/multi-url-crawling/)

推荐调度结构：

```text
Durable Frontier
  ├─ HTTP Queue        高并发
  ├─ Browser Queue     低并发、高成本
  ├─ Authorized Queue  按 Session 串行或小并发
  └─ Domain Buckets    独立限速
```

每处理完一页就持久化：

- URL 状态。
- 发现来源。
- 尝试历史。
- 下一次执行时间。
- Provider。
- 内容 Hash。
- 最终错误。

这样进程崩溃后只恢复未完成页面，而不是重跑整个站点。

## 五、降低成本的具体顺序

成本优化应按照收益从高到低进行：

1. **减少不必要的浏览器启动**

   HTTP 后立即验证，只对真正需要渲染的页面升级。

2. **请求合并**

   同一 URL 同一时间被多个任务请求时，只执行一次，其他调用共享结果。

3. **条件缓存**

   保存 `ETag`、`Last-Modified`，使用条件请求；支持 stale-while-revalidate。

4. **按阶段重试**

   抽取失败不重新下载，浏览器失败不重新跑完整 HTTP 链。

5. **浏览器资源过滤**

   在不影响目标内容的 Adapter 中关闭视频、字体和无关大图片。

6. **渐进式处理**

   抓到一页就抽取、验证、保存和流式返回，不等待整个 Crawl 完成。

7. **Adapter 替代通用推理**

   高频站点用确定性 Adapter，减少浏览器时间和 LLM 调用。

8. **成本预算**

   每个任务设最大网络字节、浏览器毫秒、重试次数、页面数和运行时间。

当前 metrics 已记录 bytes、attempts、retry delay 和 duration，但还应增加：

- `http_ms`
- `browser_ms`
- `queue_wait_ms`
- `extraction_ms`
- `validation_ms`
- `peak_memory_mb`
- `proxy_bytes`
- `cache_revalidation`
- `provider_transitions`
- `cost_per_valid_result`

## 六、建立真正的优化飞轮

这是最可能成为长期护城河的部分。

### 三层测试集

1. **离线 Fixture**

   固定 HTML、JSON、PDF、错误页和挑战页，保证抽取器确定性。

2. **受控测试网站**

   模拟延迟加载、分页、重定向、断连、429、超时和浏览器崩溃。

3. **真实 Live Canary**

   选择稳定的公开网站，每日运行，只验证标题、关键字段、正文范围和结构，不依赖全文完全不变。

测试集按页面类型分层，不能只统计一个总成功率：

- 静态文章。
- 文档站。
- SPA。
- 列表和分页。
- PDF。
- Feed/Sitemap。
- 授权页面。
- 登录墙和挑战页。
- 超时、429、5xx。
- 重定向和 canonical URL。

### Shadow Execution

抽取 1%～5% 的真实任务，同时运行 HTTP 和 Browser，但只返回正常 Planner 的结果。

然后比较：

- HTTP 是否本来就足够。
- Browser 是否真的提高了完整性。
- Planner 是否误判。
- 多花的成本是否值得。

这是训练 Access Planner 最重要的数据来源。

### 失败聚类

把失败按照以下维度聚类：

- 域名。
- 页面类型。
- Provider。
- Adapter 版本。
- 错误阶段。
- Browser 版本。
- 内容类型。
- 最近首次出现时间。

当某个域名的成功率突然下降时，就能判断是站点改版、网络问题、抽取器回归还是浏览器版本问题。

## 七、正确的实施顺序

### P0：先建立真值

- Benchmark Manifest。
- Valid/Invalid/Uncertain 标签。
- False Success Rate。
- Cost per Valid Result。
- 三层测试集和对照运行。

没有这一步，后面的优化无法证明有效。

### P1：重构执行链

- `AccessPlan`
- `ExecutionStage`
- `AttemptLedger`
- 分阶段错误与重试。
- Provider transition 证据。
- 请求合并和 Circuit Breaker。

### P2：提升浏览器可靠性

- Adaptive Readiness Policy。
- Context/Browser 健康与自动回收。
- 失败 Trace 抽样。
- HTTP 与 Browser 独立资源池。

### P3：提升内容质量

- Extractor Registry。
- Validator Registry。
- RSS、Sitemap、JSON-LD、PDF。
- 第一批高价值站点 Adapter。

### P4：并发 Crawl Engine

- Durable Frontier。
- 按域名限速。
- 自适应并发。
- Backpressure。
- 页面级 checkpoint 和流式结果。

### P5：持续优化

- Shadow Execution。
- Planner 策略数据。
- 回归报警。
- Adapter 质量排名。
- 与 Firecrawl、AnyCrawl、Crawl4AI 的同 URL 对照。

## 最重要的判断

Diaoyan 当前最应该避免三件事：

- 用“没有抛异常”代表成功。
- 为提高成功率无限重试或默认启动浏览器。
- 在没有资源治理和真值基准前提高并发。

真正的产品核心可以压缩成一句话：

> Diaoyan 在给定时间与成本预算内，选择最便宜的可靠路径，返回经过验证的有效网页数据，并对无法确认的结果拒绝伪装成功。

下一步最值得先设计和实现的是两个紧密相连的模块：

1. `Reliability Benchmark & Ground Truth Harness`
2. `Access Planner & Stage-level Attempt Ledger`

先有真值，再有优化器。否则所有“成功率提升”都只是感觉。

## 用户 · 2026-08-27T17:06:03.972Z

把所有这些都做成文档，然后做一个架构设计，就是如何来达到这些目的，需要做什么，你可以做完整的设计。我觉得我们可以做很多的探索，很多的尝试来提高我们的能力。核心就是提高能力，就是让用户花更少的钱，拿到更多的可信度。但是我们怎么做成这件事情？我觉得先有真值是没有问题的，但是现在好像并没有一个reliability的一个benchmark，我觉得你可以先做一个完整的设计，或者是探索一下怎么去做这个设计，你可以把你的探索做成文档。然后我希望我们在这次聊天过程当中，所有的东西都是能够有记录的，避免这些东西的价值其实是非常高的，我希望都记录在合适的地方。哪怕是记录到Notion中。

## 助手 · commentary · 2026-08-27T17:06:27.083Z

我会把这轮成果写进仓库，作为可版本化、可继续迭代的正式设计，而不是只留在聊天里。这里适合使用 `architecture-foundation`，因为你明确要求从目标、真值基准到执行架构做完整设计；我会先读取它的约束，再检查现有文档避免重复。Notion 暂不作为唯一存档，因为你没有指定目标页面，仓库文档更适合作为规范源。

## 助手 · commentary · 2026-08-27T17:06:39.434Z

`architecture-foundation` 要求先确定唯一状态所有者、边界契约、真值来源、验证矩阵以及每个阶段的可执行门槛。我会按这个结构落盘，并把“借鉴什么、坚决不复制什么”也写清楚，避免文档最后变成功能愿望清单。

## 助手 · commentary · 2026-08-27T17:07:01.173Z

现有文档里有一个需要纠正的方向：路线图把“多租户、账单、控制台”放在下一阶段，但我们刚刚已经确认，付费爬虫的核心应先是“单位有效结果成本”。我会保留已有能力记录，同时把接下来路线调整为真值基准、Access Planner、分阶段重试、自适应浏览器、抽取/验证 Registry 和耐久并发 Frontier；服务化只保留为以后可选的交付外壳。

## 助手 · commentary · 2026-08-27T17:11:15.499Z

Benchmark 规范和架构基础已经落盘。架构里明确选择了单一状态模型：每个请求由 append-only Attempt Ledger 持有真值，Scheduler 只负责排队，Provider 只产出不可变 Stage Result。这个选择避免了当前 Reader、Site 和 Job 各自持有一部分“成功/重试/恢复”逻辑。接下来我会把本次聊天形成的判断、纠偏和待验证假设单独记录，避免以后只剩最终结论。

## 助手 · commentary · 2026-08-27T17:13:40.312Z

记录已经形成一个闭环：Benchmark 负责真值，Architecture 负责边界和执行，Exploration Log 保留决策与可否证假设，Roadmap 按依赖排序，Product Strategy 明确多租户不是当前核心。`architecture-foundation` 也促使我保留 `docs/spec.md` 作为“已实现合同”，避免目标架构被误读成已经完成。现在做机械自检和现有测试验证。

## 助手 · final_answer · 2026-08-27T17:15:55.836Z

已经全部记录进 Diaoyan 仓库，并形成了从产品目标、真值 Benchmark、运行时架构、实验计划到实施路线的完整文档体系。没有写入 Notion，因为当前没有指定目标页面；仓库文档现在是规范源，以后可以同步成 Notion 阅读镜像。

## 新增的核心文档

1. [Reliability Benchmark 规范](/Users/lifcc/Desktop/code/diaoyan/docs/reliability-benchmark-spec.md:1)

   定义了：

   - `valid / uncertain / invalid / failed / policy_stop`
   - Valid Result Rate、False Success Rate
   - Cost per Valid Artifact
   - Browser Uplift、Retry Recovery/Waste
   - 三层 Corpus：离线 Fixture、受控测试站、Live Canary
   - Case Manifest Schema
   - Truth Evaluator 与生产 Validator 隔离
   - PR、Nightly、Release、Competitor、Shadow 五种运行模式
   - 防止通过降低测试标准“刷 Benchmark”
   - P0/P1/P2 实现位置和验证命令

2. [可靠性与成本优化架构](/Users/lifcc/Desktop/code/diaoyan/docs/reliability-architecture.md:1)

   完整设计了：

   - Access Planner
   - Execution Budget
   - Stage-level Executor
   - Append-only Attempt Ledger
   - Provider 合同
   - Browser Adaptive Readiness
   - Extractor/Validator Registry
   - Durable Frontier
   - ResourceGovernor
   - HTTP、Browser、授权 Session 分池
   - 条件缓存、singleflight、raw response 复用
   - Shadow、策略版本、Benchmark 对照和回滚
   - 现有 Reader/Site/Job 的迁移与删除条件

   `architecture-foundation` 促使这里明确了唯一状态所有者：

   > 每个请求的真值由 append-only Attempt Ledger 持有；Scheduler 只负责排队，Provider 只产生不可变 Stage Result，Artifact Store 保存经过验证的结果。

   这可以避免 Reader、Site、Job 和 Provider 分别维护一套成功、重试和恢复逻辑。

3. [Reliability Exploration Log](/Users/lifcc/Desktop/code/diaoyan/docs/reliability-exploration-log.md:1)

   记录了本次聊天中形成的高价值内容：

   - 为什么浏览器是执行器而不是整个爬虫。
   - 本地凭证的真实作用。
   - X 的 API、授权浏览器和人工 checkpoint 边界。
   - “企业级”不等于多租户。
   - 用户为什么愿意付费。
   - 七项正式架构决策。
   - 八个可否证 Hypothesis。
   - HTTP/Browser Shadow、Readiness Tournament、Retry Counterfactual、Extractor Tournament、Concurrency Sweep 等实验。
   - 哪些宣传声明目前还没有证据。

4. [文档索引](/Users/lifcc/Desktop/code/diaoyan/docs/README.md:1)

   明确区分：

   - 已实现合同：`docs/spec.md`
   - 目标架构：Reliability Architecture
   - 真值合同：Benchmark Spec
   - 研究与假设：Exploration Log
   - 实施顺序：Roadmap

## 已纠正产品和路线方向

[产品策略](/Users/lifcc/Desktop/code/diaoyan/docs/product-strategy.md:3) 现在明确：

- 付费核心是降低单位有效结果成本。
- 早期服务只需要最小 API Key、用量和数据隔离。
- 多租户、SSO、RBAC、复杂控制台不是爬虫核心。
- 护城河来自真值 Corpus、错误成功检测、Planner 数据、Adapter 和修复速度。

[路线图](/Users/lifcc/Desktop/code/diaoyan/docs/roadmap.md:89) 已从原来的“下一步服务化”调整为：

- v0.11：Reliability Truth
- v0.12：Access Planner 与 Attempt Ledger
- v0.13：Browser Readiness 与内容质量
- v0.14：Durable Concurrent Crawl Engine
- v0.15：Optimization Loop 与首批 Adapter
- 托管 API、多租户和控制台降为后续可选交付外壳

## 最终架构主线

```text
Benchmark Truth
      ↓
ReadIntent + ExecutionBudget
      ↓
Access Planner
      ↓
Stage Executor + Attempt Ledger
      ↓
Cache / HTTP / Browser / Feed / PDF / Adapter
      ↓
Extractor Registry
      ↓
Validator Registry
      ↓
valid / uncertain / invalid / failed
      ↓
Cost + Reliability Metrics
      ↓
Reviewed Policy Update
```

## 验证结果

- 本地 Markdown 链接检查：40 个内部链接，缺失 0。
- 新文档代码围栏、尾随空格、文件结尾检查通过。
- `git diff --check` 通过。
- `pnpm check` 通过。
- 22 个测试文件、200 个测试全部通过。
- 没有修改生产代码，没有提交或推送。

现在下一步已经非常清晰：先实现 v0.11 的 Case Schema、Controlled Site 和独立 Truth Evaluator，跑出 Diaoyan 的第一个真实 baseline。只有拿到这个 baseline，后续 Planner、浏览器等待、重试和并发优化才能被证明到底提升了多少。

## 用户 · 2026-08-27T17:35:58.755Z

现在我希望你把这些内容和你的聊天记录复制到SSh apple /Users/apple/Desktop/code/AI/tool/sc这个目录下，我准备在这台电脑上来接管后续的工作。你觉得有这个可能吗？就是你觉得这合理吗？就是还差什么东西吗？你觉得？你能帮我做更多的补充吗？如果差什么东西，我希望你完全把这些东西。呃，你先提交这些东西，然后放到那台电脑上面。

## 助手 · commentary · 2026-08-27T17:36:32.273Z

可以，而且这样接管很合理。为了让另一台电脑不是只拿到几份孤立文档，我会做成一个可恢复的交接包：先在本机 Diaoyan 仓库提交本轮文档；再从当前 Codex 原始会话中导出仅包含用户/助手正文的聊天记录，排除系统提示、工具日志和内部配置；最后先只读检查 `ssh apple` 上的目标目录，确认不会覆盖已有工作，再把完整 Git 历史、文档、聊天导出和接管说明放过去并在远端验证。

## 助手 · commentary · 2026-08-27T17:37:03.737Z

远端检查结果很好：`ssh apple` 可用，目标 `/Users/apple/Desktop/code/AI/tool/sc` 已存在且完全为空，因此可以把它直接作为 Diaoyan 仓库根目录，不会覆盖旧文件。我也已经定位到当前原始 Codex 会话。下一步会先生成一份经过净化的用户/助手 transcript 和接管说明，一起提交；不会复制系统提示、开发者指令、工具调用原始日志或任何凭证。
