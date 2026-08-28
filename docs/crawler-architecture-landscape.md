# 爬虫技术架构全景与选型证据

状态：Architecture Research
研究日期：2026-08-28
配套决策：[technology-selection-rfc.md](./technology-selection-rfc.md)

## 1. 研究结论先行

“爬虫”不是一种架构，而是至少六种目标不同的系统：单页读取库、批量站点爬虫、持续流式
Crawler、网页归档器、浏览器执行基础设施、托管解封/提取 API。它们选择不同技术，主要不是因为
语言偏好，而是因为各自的瓶颈不同。

| 系统目标 | 首要瓶颈 | 典型设计 |
| --- | --- | --- |
| 单页或小规模读取 | 开发效率、正文质量 | 进程内异步 HTTP，必要时浏览器 |
| 大规模批处理 | Frontier 容量、去重、磁盘顺序吞吐 | 磁盘/分布式状态，批次生成与抓取 |
| 持续增量抓取 | 背压、失败恢复、状态反馈 | 流处理拓扑，URL 状态回写 Frontier |
| 高保真归档 | 浏览器捕获、可重放性、长期保存 | 浏览器 + WARC/WACZ + checkpoint |
| 动态/受保护页面 | Chrome 成本、会话隔离、代理质量 | 独立浏览器池，严格并发上限和队列 |
| Agent 网页上下文 | 错误成功、延迟、单位有效结果成本 | HTTP-first 路由、验证、按需升级、结构化产物 |

对 Diaoyan 最重要的结论有六条：

1. **不要 browser-first。** Crawlee 官方材料把纯 HTTP 路径描述为约比 Playwright 快一个数量级；
   Browserless 也明确建议通过横向扩容控制 Chrome 的 CPU/内存争用。浏览器应是验证驱动的升级路径。
2. **不要把队列当真值库。** 队列适合唤醒和分发，Request/Attempt/Artifact 的最终状态需要事务型
   权威存储，否则崩溃恢复、取消和去重会互相打架。
3. **按 origin 调度比全局并发更重要。** 礼貌延迟会直接限定单站吞吐；提高全局并发只对域名足够
   多的工作集有效。
4. **HTTP 200 不等于成功。** Zyte 的公开接口甚至允许浏览器 action 失败而请求本身成功。登录墙、
   challenge、空壳和残缺正文必须由独立 Validator 判定。
5. **先做单机耐久内核，再做分布式。** SQLite WAL 适合本地单写者；真正出现多主机 Worker 后再将
   权威 Frontier 切到 PostgreSQL。Redis/RabbitMQ 可做通知层，不应在 P0 同时引入。
6. **控制面继续用 TypeScript。** 当前瓶颈主要在目标站、礼貌等待和 Chrome，不在语言运行时。只有
   Benchmark 证明 HTTP Worker 的 CPU/内存成为约束，才值得增加 Go/Rust Provider。

## 2. 方法、边界与证据等级

“所有知名爬虫”无法形成封闭全集。本研究采用**架构类型饱和**：覆盖每一种有实质差异的主流形态，
再在该形态下选择有公开源码、官方架构文档或论文的代表。清单共覆盖 25 个系统/产品族。

证据只使用官方文档、官方仓库、标准或原作者论文，不用二手博客推测闭源实现。

| 等级 | 含义 | 本文如何使用 |
| --- | --- | --- |
| A | 源码、官方架构文档、标准或论文可直接验证 | 可描述内部组件和数据流 |
| B | 官方 API/运行模型可验证，内部实现未公开 | 只描述外部合同和可观察行为 |
| C | 基于 A/B 证据的设计推论 | 必须明确写“推论”，不能当产品事实 |

性能数字只用于说明数量级或瓶颈，不能横向排榜。历史论文、合成请求、真实礼貌抓取、浏览器渲染的
测试口径完全不同；采购和最终选型仍需统一 Corpus 实测。

## 3. 第一性原理：到底优化什么

一个 Agent Web Retrieval 系统应优化：

```text
maximize   valid_artifacts
minimize   false_successes + total_execution_cost + valid_latency
subject to policy + authorization + freshness + resource budgets
```

由此导出 15 个必须分开评估的架构节点：

1. Intake：同步 read、异步 crawl、定时任务还是流式输入。
2. URL identity：规范化、redirect/canonical 关系、去重键。
3. Frontier：优先级、due time、深度、配额和恢复。
4. Politeness：robots、origin/IP 并发、crawl delay、退避。
5. Planner：何时 cache、HTTP、feed、PDF、browser 或托管 Provider。
6. Fetch executor：连接池、流式 body、限制、重试和取消。
7. Browser runtime：进程、context、page 生命周期及 readiness。
8. Identity/session：Cookie、授权范围、序列化和审计。
9. Extraction：正文、结构化数据、PDF、站点 Adapter、可选模型。
10. Validation：结果是否满足用户任务，而非是否返回 2xx。
11. Storage：原始响应、产物、元数据、索引和保留策略。
12. Delivery：同步返回、轮询、webhook、stream。
13. Backpressure：CPU、内存、浏览器 slot、目标站和预算。
14. Recovery/observability：lease、attempt、trace、provenance、成本。
15. Extension/security：插件权限、SSRF、凭证边界、许可和审计。

任何只比较“支持 JS / 支持 Markdown / 支持代理”的清单，都不足以做架构决策。

## 4. 开源系统的内部架构对比

### 4.1 总表

| 系统 | 主要技术 | Frontier/并发 | 浏览器 | 状态与恢复 | 为何这样选 | 对 Diaoyan 的启示 |
| --- | --- | --- | --- | --- | --- | --- |
| Scrapy | Python、Twisted | Engine + Scheduler，非阻塞 Downloader，按 slot/域限流 | 非原生 | 内存或磁盘队列，可持久 Job | 事件驱动适合 I/O；middleware/pipeline 支撑抓取生态 | 借鉴分层与中间件边界，不照搬 Python 运行时和历史扩展面 |
| Crawlee | TypeScript/Node，另有 Python | RequestQueue + AutoscaledPool，根据 CPU/内存调并发 | Playwright/Puppeteer + BrowserPool | 本地/云存储、Request 状态 | 与 JS 页面和 Playwright 生态同栈；资源感知调度保护主机 | 最接近本项目，但 Adaptive crawler 仍标实验性，验证合同需自有 |
| Colly | Go、net/http | callback，sync/async，LimitRule | 无原生 | 默认内存，可换 Redis 等 Storage | goroutine + net/http 获得简单、低开销 HTTP 并发 | 证明 Go 适合独立 HTTP Worker，不证明应重写控制面 |
| Apache Nutch | Java、Hadoop、Gora | inject→generate→fetch→parse→updatedb 批处理 | 非核心 | 分布式 CrawlDb/LinkDb/segments | 搜索引擎规模重视批次吞吐和可重跑 | 适合离线建索引，不适合低延迟单 URL Agent 请求 |
| StormCrawler | Java、Apache Storm | spout/bolt 流拓扑，URL Frontier 状态反馈 | 可扩展 | URLFrontier、OpenSearch/Solr/SQL 等 | 连续抓取需要流式背压、故障恢复和水平扩展 | 借鉴状态回写与按 host 分区；P0 不引入 Storm 集群 |
| UbiCrawler | Java、分布式 | consistent hashing 按主机分派 | 无 | 分布式状态 | 一致性哈希减少协调并支持节点变化 | 适合作为未来 origin shard 的理论参考 |
| BUbiNG | Java、分布式 | 大型 per-host frontier、严格 host/IP politeness | 无 | 磁盘友好结构 | 目标是多域高吞吐且保持礼貌 | 吞吐来自域名多样性和 Frontier 设计，不只是线程数 |
| Heritrix | Java、Berkeley DB JE | URI Frontier | 非主要目标 | checkpoint、BDB、WARC | 互联网归档优先可恢复和长期可重放 | 借鉴原始证据与 checkpoint，不照搬归档工作流 |
| Browsertrix Crawler | TypeScript、Puppeteer、Brave、CDP | 单容器 crawl；Cloud 用 K8s 编排 pods | 核心执行面 | Redis 去重/队列，WARC/WACZ | 归档要求浏览器级网络捕获和可重放产物 | 高保真路径可借鉴；不应用作所有页面默认路径 |
| Crawl4AI | Python asyncio、Playwright、LXML | 内存感知或 semaphore dispatcher、stream | 默认核心 | cache；非分布式耐久 Frontier 核心 | 面向 AI 的 Markdown/结构化提取，强调本地易用 | 借鉴产物体验与资源 dispatcher；补足权威状态和恢复 |
| Firecrawl OSS | TypeScript API/Worker、Playwright service | API + Worker；NuQ/PostgreSQL 队列，RabbitMQ 通知 | 独立服务 | PostgreSQL、Redis、RabbitMQ；可选实验队列后端 | 对外隐藏复杂抓取，将昂贵执行器独立扩缩 | 证明产品 API 可简洁但基础设施可很重；不应作为本地 P0 拓扑 |
| AnyCrawl | TypeScript/Node | API + Redis + Cheerio/Playwright/Puppeteer workers | 多独立 Worker | Redis job 状态/队列 | 多引擎 Worker 易部署、易水平扩展 | 可借鉴 provider 隔离；Redis-only 真值与恢复证据不足 |
| Apify Crawlee/Actors | Node/容器平台 | 每次运行 Actor + Request Queue | 常见 | Dataset、KV、Request Queue；运行可恢复 | 容器运行、存储和市场统一成平台合同 | 适合外部 Provider/Adapter 市场参考，不适合本地内核依赖 |
| Steel | Node、Chrome、Docker | Browser API 并发 | 核心 | session 级 | 把浏览器变成独立可调用基础设施 | 是 Browser Provider，不是 Frontier/Validator 完整方案 |

### 4.2 代表系统详解

#### Scrapy：事件引擎型

Scrapy 的 Engine 在 Spider、Scheduler、Downloader 和 Item Pipeline 之间传递 Request/Response/Item，
Downloader 与 middleware 基于 Twisted 非阻塞事件循环。Scheduler 可以使用内存或磁盘队列，并将
去重与顺序策略隔离出来。

- 优点：组件职责稳定；下载器与解析器解耦；插件生态成熟；小团队能快速写站点 Spider。
- 代价：Browser、跨进程 Frontier、Artifact 真值不是核心抽象；middleware 组合复杂后很难解释一次
  请求为什么走到某条路径。
- 可借：Engine/Scheduler/Downloader/Pipeline 的边界。
- 不可直接借：把“Response 已收到”当作业务成功，以及无边界扩展 middleware。

来源：[Architecture](https://docs.scrapy.org/en/master/topics/architecture.html)、
[Scheduler](https://docs.scrapy.org/en/latest/topics/scheduler.html)。

#### Crawlee：资源感知的多执行器型

Crawlee 用 RequestQueue 管理 URL，AutoscaledPool 根据系统 CPU/内存调节并发，BrowserPool 管浏览器
实例与 page。它同时提供 HTTP/Cheerio 和 Playwright/Puppeteer crawler；AdaptivePlaywrightCrawler
尝试预测页面是否需要渲染，并允许比较浏览器与 HTTP 结果，但官方仍标为实验性。

- 优点：Node/TypeScript 与 Playwright 同生态；本地到 Apify Cloud 的演进平滑；资源治理成熟。
- 代价：其目标包含通用 scraping 和身份轮换，不等同于本项目的合规/证据边界；动态路由的
  “真值”仍需产品自己定义。
- 性能证据：官方 Playwright crawler README 将纯 HTTP crawler 描述为约快 10 倍。这是方向性证据，
  不是跨站点 SLA。

来源：[BrowserCrawler](https://crawlee.dev/js/api/browser-crawler)、
[BrowserPool](https://crawlee.dev/js/api/browser-pool/class/BrowserPool)、
[Request loaders](https://crawlee.dev/js/docs/next/guides/request-loaders)、
[Adaptive crawler](https://crawlee.dev/js/api/playwright-crawler/class/AdaptivePlaywrightCrawler)、
[SystemStatus](https://crawlee.dev/js/api/3.7/core/class/SystemStatus)、
[Playwright crawler README](https://github.com/apify/crawlee/blob/master/packages/playwright-crawler/README.md)。

#### Nutch 与 StormCrawler：批处理和流处理不是同一道题

Nutch 把一次 crawl 拆为注入、生成 segment、抓取、解析、更新 CrawlDb、倒排链接和索引等批次。
这个形态便于大规模重跑和 Hadoop 数据处理，但首条结果延迟高。StormCrawler 则将 URL 通过 Storm
spout/bolt 持续流转，抓取、解析和状态更新形成反馈环，Frontier 负责优先级、重试和 politeness。

- Nutch 适合周期性全站索引。
- StormCrawler 适合持续增量和多 Worker 背压。
- Diaoyan 的单 URL/小 crawl 需要低延迟，但未来 monitor 需要持续调度；因此应该共享状态模型，
  而不是直接采用批处理或 Storm 平台。

来源：[Nutch tutorial](https://cwiki.apache.org/confluence/spaces/NUTCH/pages/115512208/NutchTutorial)、
[Nutch repository](https://github.com/apache/nutch)、
[StormCrawler architecture](https://stormcrawler.apache.org/docs/latest/index.html)、
[StormCrawler FAQ](https://stormcrawler.apache.org/docs/)。

#### Heritrix 与 Browsertrix：归档正确性型

Heritrix 的 URI Frontier、Berkeley DB JE、checkpoint 和 WARC 面向长时间、大规模、可恢复归档。
Browsertrix 进一步用 Puppeteer 控制 Brave，通过 CDP 捕获浏览器网络，输出 WARC/WACZ；其云端项目
用 Kubernetes 编排 crawler pods，并使用 Redis 支撑队列/去重。

这类系统证明“原始证据”和“最终产物”应分离。它们没有证明 browser-first 适合低成本 Agent read；
归档的页面保真和重放目标远高于正文抽取，因此资源预算不可直接比较。

来源：[Heritrix docs](https://heritrix.readthedocs.io/en/latest/)、
[Heritrix operating/checkpoints](https://heritrix.readthedocs.io/en/latest/operating.html)、
[Browsertrix Crawler](https://github.com/webrecorder/browsertrix-crawler)、
[Browsertrix orchestration](https://github.com/webrecorder/browsertrix)、
[Browsertrix dedupe](https://crawler.docs.browsertrix.com/develop/dedupe/)。

#### Firecrawl 与 AnyCrawl：产品 API + 异构 Worker 型

Firecrawl 当前开源部署由 TypeScript API/Worker、独立 Playwright 服务、PostgreSQL、Redis 和 RabbitMQ
等组成；源码和 Compose 显示 NuQ 以 PostgreSQL 为权威队列、RabbitMQ 做通知，另有实验性后端。
官方自托管说明也明确 Compose 是起点而非生产架构。AnyCrawl 则采用更直接的 API + Redis +
Cheerio/Playwright/Puppeteer Worker 组合。

- 优点：用户只看见 scrape/crawl/extract/job，执行层可独立扩缩。
- 代价：本地部署的服务数、故障面和资源常驻成本明显上升；多套状态设施会增加一致性工作。
- 结论：Diaoyan 应借 API/Worker 分离，但只在规模证明后增加通知中间件。

来源：[Firecrawl self-host](https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md)、
[Firecrawl Compose](https://github.com/firecrawl/firecrawl/blob/main/docker-compose.yaml)、
[Firecrawl API source](https://github.com/firecrawl/firecrawl/blob/main/apps/api/src/index.ts)、
[AnyCrawl repository](https://github.com/any4ai/anycrawl)、
[AnyCrawl Docker architecture](https://docs.anycrawl.dev/en/general/docker)。

## 5. 闭源产品：能确认什么，不能确认什么

### 5.1 对外执行模型

| 产品 | 官方可验证能力（B 级） | 内部架构 | 选型含义 |
| --- | --- | --- | --- |
| [Zyte API](https://docs.zyte.com/zyte-api/usage/reference.html) | HTTP、browser、自动提取、session、network capture、typed errors | 未公开 | 最接近“按成本选择访问路径”；独立验证仍必要 |
| [Bright Data Web Unlocker](https://docs.brightdata.com/scraping-automation/web-unlocker/introduction) | 代理、浏览器、重试、解封封装成请求 API | 未公开 | 适合作为高难站点 Provider，不应成为状态真值源 |
| [Oxylabs Web Scraper API](https://developers.oxylabs.io/help-center/products-and-features/web-scraper-api-features) | realtime/batch、JS rendering、browser instructions、XHR、custom parser | 未公开 | 证明批量交付和站点 parser 有商业价值 |
| [Diffbot](https://docs.diffbot.com/docs/is-there-a-limit-to-the-number-of-crawlsbulk-jobs) | Crawl/Bulk job、自动提取、Knowledge Graph | 未公开 | 优化的是语义实体层，不是通用本地执行器 |
| [ScrapingBee](https://www.scrapingbee.com/documentation/) | HTTP API 暴露 JS rendering、代理和提取选项 | 未公开 | 中小规模按次购买可降低运维，但可解释性有限 |
| [Browserbase](https://docs.browserbase.com/platform/browser/core-features/contexts) | session、context、CDP、日志/视频/网络、并发配额、多区域 | 未公开 | 可作为远程 Browser Provider；context 应按站点/身份隔离 |
| [Browserless](https://docs.browserless.io/enterprise/open-source) | 托管和开源容器版、并发/queue/429、pressure/metrics | 部分公开 | 浏览器应有独立容量池，扩容优先于无限提高单机并发 |
| [Apify Platform](https://docs.apify.com/actors/running/runs-and-builds) | Actor 容器、持久 Dataset/KV/RequestQueue、资源配额 | 平台内部未公开 | 可作为外部 Actor Provider 和 Adapter 市场参考 |
| [Firecrawl Cloud](https://docs.firecrawl.dev/introduction) | scrape/crawl/map/search/interact，队列状态和并发限制 | 托管部分未公开 | 产品表面值得参考，不能从 OSS Compose 推定云端拓扑 |
| [Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/crawl) | search/extract/map/crawl/research；crawl 有 depth/limit/path/instruction | 未公开 | 更像 Agent 检索面；可做外部 discovery/provider |
| [Parallel](https://docs.parallel.ai/extract/extract-quickstart) | URL→Markdown/PDF/JS 内容，可按 objective 返回相关片段 | 未公开 | 适合外部 Extract Provider，不替代自有证据账本 |
| [Jina Reader](https://jina.ai/reader/) | direct、browser、实验 renderer；Markdown/JSON/模型提取 | 服务实现仅部分公开 | 明确印证 direct 快、browser 慢的分层执行模型 |
| [Exa](https://exa.ai/docs/reference/get-contents) | search、contents、Agent、Websets 产品接口 | 未公开 | 属于检索/语义索引服务，不是可自托管 Crawler 内核 |

闭源产品常公布“自动选择”“高成功率”“自动重试”，却不公布 Frontier、重试放大、去重语义、
浏览器池调度和真值标签。本文不会把这些营销描述反推成内部组件。

### 5.2 三个可直接采用的合同事实

1. Zyte 文档明确区分 HTTP 和 browser：HTTP 通常更快、更便宜；browser 质量可能更高，但执行更复杂。
   同时，部分 action/extraction 问题可通过结果字段呈现，而顶层 API 仍成功。因此 Provider success
   与 Artifact validity 必须是两个状态。
2. Browserbase 把 session 和可持久 context 分开，context 保存用户数据，并建议同一 context 不被并发
   使用。这支持“匿名页面并行、授权身份按 origin 串行”的本地模型。
3. Browserless 的并发队列、429、pressure 和 metrics 说明浏览器不是普通 HTTP socket；它需要独立
   ResourceGovernor 和显式背压。

来源：[Zyte HTTP](https://docs.zyte.com/zyte-api/usage/http.html)、
[Zyte browser](https://docs.zyte.com/zyte-api/usage/browser.html)、
[Zyte sessions](https://docs.zyte.com/zyte-api/usage/features.html)、
[Zyte errors](https://docs.zyte.com/zyte-api/usage/errors.html)、
[Bright Data Web Unlocker](https://docs.brightdata.com/scraping-automation/web-unlocker/introduction)、
[Oxylabs features](https://developers.oxylabs.io/help-center/products-and-features/web-scraper-api-features)、
[Oxylabs browser instructions](https://developers.oxylabs.io/scraping-solutions/web-scraper-api/features/js-rendering-and-browser-control/browser-instructions)、
[Browserbase contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)、
[Browserbase observability](https://docs.browserbase.com/platform/browser/observability/observability)、
[Browserbase concurrency](https://docs.browserbase.com/optimizations/concurrency/overview)、
[Browserless open source](https://docs.browserless.io/enterprise/open-source)、
[Browserless long queues](https://docs.browserless.io/enterprise/long-queues)、
[Browserless best practices](https://docs.browserless.io/enterprise/docker/best-practices)。

Agent 检索接口来源：[Tavily Crawl](https://docs.tavily.com/documentation/api-reference/endpoint/crawl)、
[Parallel Extract](https://docs.parallel.ai/extract/extract-quickstart)、
[Jina Reader](https://jina.ai/reader/)。这些产品的公开接口可纳入将来的同 URL Benchmark，但不能支持
对其内部数据库、队列或调度算法做结论。

## 6. 按架构节点横向比较

### 6.1 Frontier 与队列

| 方案 | 优点 | 硬限制 | 适用阶段 |
| --- | --- | --- | --- |
| 进程内队列 | 最简单、延迟最低 | 崩溃丢失，无法多 Worker | 仅短请求或测试 |
| SQLite WAL lease 表 | 单文件、事务、查询/去重方便 | 同时只有一个 writer；WAL 仅同机 | 本地和单机服务推荐 |
| PostgreSQL + `SKIP LOCKED` | 事务状态与 Worker lease 同库，多机成熟 | 需要服务运维；高热点需分区/索引 | 多主机推荐 |
| Redis list/stream | 低延迟，consumer group/ack/pending | 持久化/故障切换语义需额外设计；不是关系真值 | 通知、缓存或明确可丢任务 |
| RabbitMQ quorum queue | ack、publisher confirm、复制队列成熟 | 集群运维；复杂优先级/URL 状态仍需数据库 | 大规模 Worker 唤醒 |
| Kafka | 高吞吐 durable log、partition 顺序 | due-time 优先 work queue 不自然 | 事件审计/下游流，不作 P0 Frontier |
| Temporal | durable workflow 与重试语义强 | 控制面较重；每页优先 Frontier 仍需建模 | 长业务工作流而非 P0 每页抓取 |

来源：[SQLite WAL](https://www.sqlite.org/wal.html)、
[When to use SQLite](https://www.sqlite.org/whentouse.html)、
[PostgreSQL `SKIP LOCKED`](https://www.postgresql.org/docs/15/sql-select.html)、
[Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)、
[RabbitMQ quorum queues](https://www.rabbitmq.com/docs/4.2/quorum-queues)、
[Kafka design](https://kafka.apache.org/documentation/)、
[Temporal](https://docs.temporal.io/)。

选择：本地 SQLite WAL；多机 PostgreSQL。Redis/RabbitMQ 只有在基准证明数据库轮询或通知延迟成为
瓶颈后再加，且不取代权威状态。

### 6.2 HTTP、浏览器和托管 Provider

| 路径 | 启动/内存成本 | 能力 | 典型失败 | 默认策略 |
| --- | --- | --- | --- | --- |
| Cache/revalidate | 最低 | 已知内容和 freshness | 陈旧、key 错误 | 首选 |
| Feed/API/JSON | 很低 | 结构稳定、语义明确 | 入口发现不足 | 发现后优先 |
| HTTP | 低 | HTML、文件、重定向 | JS shell、gate、残缺正文 | 网络默认 |
| 本地 Playwright | 高 | JS、交互、授权 session | 资源耗尽、等待误判、崩溃 | Validator 触发后升级 |
| 远程 Browser | 高且有费用 | 隔离、弹性、观察 | 网络延迟、数据边界、配额 | 可选 Provider |
| 解封/提取 API | 可变且通常最高 | 难站、代理、站点 parser | 供应商不透明、成本、政策边界 | 明确授权与预算下最后路径 |

关键不是写死 `HTTP -> Browser`，而是 Planner 根据内容类型、历史证据、错误类型、授权和剩余预算
生成有限状态计划；Validator 决定候选结果是否终止，而 Provider 不能自行宣布最终成功。

### 6.3 语言与运行时

| 选择 | 强项 | 弱项 | 结论 |
| --- | --- | --- | --- |
| TypeScript/Node | MCP/Web/Playwright 一致；异步 I/O；现有代码和团队上下文 | CPU 密集解析和超大堆需治理 | 控制面、HTTP P0、Browser Provider 推荐 |
| Go | goroutine、net/http、低内存单二进制 | Browser/DOM/AI extraction 生态较弱 | 经基准触发后可做 HTTP Worker |
| Rust | 性能、内存安全、可控资源 | 交付成本和生态集成成本最高 | 仅明确热路径或嵌入组件 |
| Python | Scrapy/数据/ML 提取生态最好 | 与现有 TS 双运行时；CPU 并发需进程化 | 可选 Extractor Worker，不建议整体重写 |
| Java | Nutch/Storm/Heritrix 分布式和归档成熟 | 本地 Agent 产品运维较重 | 大规模离线/流式系统参考，不作当前主栈 |

代表项目逐一映射如下。这里的“主语言”指 crawler runtime/control plane 的主要实现，不把 HTML、测试、
部署 YAML 或少量 native dependency 算成另一套架构；闭源服务没有公开的信息不作猜测。

| 项目/产品族 | 主语言/运行时 | 实际抓取执行面 | 架构类型 |
| --- | --- | --- | --- |
| Diaoyan（当前与推荐 P0） | TypeScript / Node.js | Undici；Playwright 控制 Chrome | HTTP-first Agent retrieval |
| Scrapy | Python，Twisted | 异步 HTTP Downloader | 事件引擎框架 |
| Crawlee for JavaScript | TypeScript / Node.js | raw HTTP/Cheerio、Playwright 或 Puppeteer | 多执行器框架 |
| Crawlee for Python | Python | HTTP 与 Playwright 等 Python Adapter | 多执行器框架的独立实现 |
| Colly | Go | `net/http` + callback/collector | 轻量高并发 HTTP 框架 |
| Katana | Go | HTTP 与可选 headless 模式 | 安全/自动化导向 crawler |
| Spider | Rust | async Rust HTTP，功能依 crate 配置 | 高并发 library |
| Apache Nutch | Java | Hadoop/Gora batch fetch | 分布式批处理 crawler |
| StormCrawler | Java | Apache Storm spout/bolt | 持续流式 crawler |
| crawler4j | Java | Java HTTP/HTML parsing | 进程内 crawler library |
| UbiCrawler | Java | 分布式 HTTP fetch | 一致性哈希研究系统 |
| BUbiNG | Java | 高吞吐 HTTP fetch | 大规模礼貌 crawler |
| Heritrix | Java | HTTP crawl + WARC | 归档 crawler |
| Browsertrix Crawler | TypeScript / Node.js | Puppeteer 控制 Brave/Chromium | 浏览器归档 crawler |
| Crawl4AI | Python | Playwright 控制 Chromium | AI 内容提取 crawler |
| Firecrawl OSS | 主要为 TypeScript / Node.js | HTTP worker + 独立 Playwright service | API + queue + worker |
| AnyCrawl | TypeScript / Node.js | Cheerio、Playwright、Puppeteer workers | 多引擎微服务 |
| Browserless | TypeScript / Node.js | Chrome/Chromium 容器池 | Browser infrastructure |
| Steel | TypeScript / Node.js | Chrome/Chromium | Browser infrastructure |
| Apify Platform | 平台内部未知；Actor 可多语言 | Actor 自带 crawler/browser | 闭源容器运行平台 |
| Zyte/Bright Data/Oxylabs | 未公开 | 官方只公开 HTTP/browser API 合同 | 闭源访问 Provider |
| Diffbot | 未公开 | 官方只公开 crawl/extract/KG 合同 | 闭源语义数据平台 |
| Tavily/Parallel/Exa/Jina | 未公开或仅部分开源 | 官方只公开 search/extract/reader 合同 | Agent retrieval API |

这个分布说明：Python 强在 Spider/解析生态，Java 强在历史分布式与归档，Go/Rust 强在纯 HTTP 热路径，
TypeScript 强在 HTTP 与浏览器的统一控制。它不能单独推出性能胜负；同一种语言内部的 Frontier、解析、
持久化和默认重试配置，往往比语言本身造成更大差异。

Colly 官方合成示例称单核可超过 1,000 requests/s；历史 IRLbot 论文报告单服务器 41 天抓取
63 亿页面、平均 1,789 pages/s。这些数字证明专用 HTTP Frontier 的上限很高，但没有包含本项目的
真实站点礼貌、浏览器、验证和产物成本，不能作为重写理由。

来源：[Colly](https://github.com/gocolly/colly)、
[Scrapy repository](https://github.com/scrapy/scrapy)、
[Crawlee repository](https://github.com/apify/crawlee)、
[IRLbot paper](https://s1.irl.cs.tamu.edu/people/hsin-tsang/papers/tweb2009.pdf)、
[Mercator paper](https://www.cs.ucr.edu/~vagelis/classes/CS172/publications/scalable-crawler.pdf)、
[UbiCrawler paper](https://onlinelibrary.wiley.com/doi/pdf/10.1002/spe.587)、
[BUbiNG paper](https://arxiv.org/abs/1601.06919)。

## 7. 性能：真正需要测什么

### 7.1 理论上限

单一 origin 若要求 1 秒间隔，无论用 Rust、Go 还是集群，理论上每天最多约 86,400 次。只有跨大量
origin 的工作集才能用全局并发提高吞吐。因此性能必须同时报告：

- 全局 valid artifacts/s；
- 每 origin 请求间隔违规数；
- HTTP 与 browser 分开统计的 p50/p95；
- queue wait、origin wait、network、render、extract、validate 分段耗时；
- 峰值内存、浏览器 context 数、bytes、retry amplification；
- cost per valid artifact，而不是 raw requests/s。

### 7.2 禁止的比较

- 不把 localhost 静态页请求率和真实公网 crawl 放一张排名表。
- 不把 200/markdown returned 当 valid。
- 不忽略 robots、429、redirect、挑战页和授权边界。
- 不用 warm cache 成绩代表 cold fetch。
- 不用云产品“自动”描述推定其内部选择算法。
- 不把浏览器启动成本平均隐藏在很长的批任务里。

统一测试合同见 [reliability-benchmark-spec.md](./reliability-benchmark-spec.md)。

### 7.3 受控 HTTP 引擎基准（2026-08-28）

为了把“语言印象”变成同机证据，仓库已落地可复现的 HTTP engine benchmark。四个 runner 抓取同一个
localhost 受控站点：1,000 个确定性 4 叉图页面，每页 8 KiB；关闭 retry、Cookie 和 robots，逐页校验
状态码、响应头、页面 marker 和链接发现结果。每个档位预热 1 次、计量 5 次并取中位数。任何一轮不是
1,000/1,000 valid、出现漏页或额外请求，都不得进入排名。本次 60 个计量轮次全部通过，且零重复、
零失败。

环境：Apple M2 Max（12 logical CPUs，96 GiB），macOS arm64；Node.js 25.9.0、CPython 3.14.2、
Go 1.25.7。引擎版本：Undici（项目锁定版本）、Crawlee CheerioCrawler 3.16.0、Scrapy 2.16.0、
Colly 2.3.0。

下表为 runner 内部 crawl window 的中位 valid pages/s；它排除进程启动，但包含抓取、正文读取、
marker 校验与链接发现：

| Runner | 语言 | concurrency 1 | concurrency 8 | concurrency 32 |
| --- | --- | ---: | ---: | ---: |
| Undici | TypeScript / Node.js | 652 | 959 | 1,618 |
| Crawlee CheerioCrawler | TypeScript / Node.js | 589 | 206 | 688 |
| Scrapy | Python | 56 | 165 | 722 |
| Colly | Go | 348 | 3,871 | 13,626 |

并发 32 时的资源和端到端中位数如下。`wall` 由 macOS `/usr/bin/time -l` 从进程外测量，包含运行时
和框架启动；RSS 是进程峰值常驻内存：

| Runner | crawl ms | wall ms | peak RSS | internal valid pages/s |
| --- | ---: | ---: | ---: | ---: |
| Undici | 618 | 1,439 | 191 MiB | 1,618 |
| Crawlee CheerioCrawler | 1,454 | 3,195 | 364 MiB | 688 |
| Scrapy | 1,384 | 1,826 | 114 MiB | 722 |
| Colly | 73 | 84 | 33 MiB | 13,626 |

这组证据支持三个有限结论：

1. **Go 是高并发纯 HTTP worker 的明确候选。** 在这个 CPU/loopback 主导的档位，Colly 的内部吞吐
   约为 Undici 的 8.4 倍，峰值 RSS 约为其六分之一。如果生产 trace 证明 HTTP worker 本身成为持续
   热点，单独增加 Go execution provider 有充分理由。
2. **P0 保留 TypeScript + Undici 仍然合理。** Undici 已在 0.62 秒内完成 1,000 个带校验页面；真实
   crawl 通常先受网络、每 origin 礼貌、429 和浏览器限制。现在整体重写会先支付协议、部署和双栈维护
   成本，却没有证明 valid artifacts/s 会同比提高。
3. **框架能力不能用语言标签代替。** Scrapy 从 concurrency 1 到 32 提升约 12.8 倍，在 32 档内部
   吞吐略高于 Crawlee且内存约为三分之一；同为 TypeScript 的 Crawlee 与裸 Undici 也有显著差距。
   Frontier、调度、存储和框架生命周期，足以比语言本身产生更大的开销。

这不是“真实世界爬虫总榜”。它没有 DNS/TLS、压缩、代理、robots、按 origin 延迟、429、重试、
持久化 frontier、JavaScript 渲染、挑战页和内容质量差异；4 叉图也不代表任意网站结构。Crawlee 在
部分轮次有明显离散，结果只报告中位数，不把单轮峰值当结论。该基准只回答一个问题：在相同静态
HTTP 获取与校验合同下，各执行引擎的本机热路径成本是多少。运行入口为 `pnpm bench:http`，实现与
真值门槛由 focused tests 覆盖。

## 8. 对本项目的直接决策输入

| 问题 | 证据支持的答案 | 何时复审 |
| --- | --- | --- |
| 是否重写为 Go/Rust？ | 否；先保留 TS，隔离 Provider 合同 | Node HTTP worker CPU/内存成为可重复瓶颈 |
| 是否直接用 Crawlee？ | 不作为核心真值引擎；可做 prototype 或 Provider | 自研 Frontier/BrowserPool 明显拖慢交付且合同可映射时 |
| 是否 browser-first？ | 否；cache/feed/API/HTTP 后按验证升级 | 浏览器 uplift 数据证明多数目标确需渲染 |
| 是否现在上微服务？ | 否；先模块化单进程 + browser 子进程 | 多主机容量或故障隔离成为真实需求 |
| SQLite 还是 PostgreSQL？ | 本地 SQLite WAL；集群 PostgreSQL | 多主机 Worker、writer wait 或数据库体积触发门槛 |
| Redis/RabbitMQ/Kafka？ | P0 都不必需 | PostgreSQL 通知/lease 吞吐经基准不足 |
| 是否自己做所有解封？ | 否；保持 Provider 接口，合规预算内接外部服务 | 统一 Benchmark 得出成本/有效率优势 |
| LLM 是否进入热路径？ | 否；确定性解析和验证优先 | 仅在不确定样本有可测 uplift 且单位成本可接受 |

最终推荐和替代方案评分见 [technology-selection-rfc.md](./technology-selection-rfc.md)。

## 9. 研究缺口

以下信息无法从公开资料严谨取得，必须通过后续实测补齐：

- 闭源服务的真实 Frontier、浏览器复用、失败重试和去重语义。
- 同 URL、同地区、同新鲜度下的 valid rate、false-success rate 和实际账单。
- 当前项目真实工作集的静态/JS/授权/PDF/Feed 比例。
- 本地 Chrome 的 context 安全并发和内存曲线。
- SQLite 在目标队列规模和 attempt 写入速率下的 writer wait。
- 远程 Browser/解封 Provider 的数据保留、区域和授权合规需求。

这些缺口不会阻止 P0 架构，因为推荐方案把它们放在可替换 Provider 和可量化迁移门槛之后。
