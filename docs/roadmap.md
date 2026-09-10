# Crawlume 路线图

## v0.1 已完成

- 单页 HTTP 读取。
- 真实 Chrome 渲染回退。
- Readability 与 Markdown 提取。
- SQLite 成功结果缓存。
- SSRF、robots、重定向、超时和响应大小保护。
- 专用授权 Profile。
- CLI 与 MCP。
- 结构化错误和读取证据。

## v0.2 站点读取（已完成）

- `map`：同域 URL 发现、深度和页数限制、部分失败报告。
- `crawl`：边发现边读取正文，返回成功页与逐页错误。
- 默认串行和有界规模，避免对网站制造突发流量。
- CLI 与 MCP 使用同一实现。
- 测试站点范围、去重、查询参数、深度、截断和失败语义。

## v0.3 搜索发现（已完成）

- Provider 无关的搜索服务边界。
- SearXNG JSON Provider，支持本地自建实例。
- `search` CLI 与 `search_web` MCP 工具。
- 标准化结果、分页、语言、安全搜索和时间范围。
- 未配置、JSON 禁用和异常响应的显式失败。

## v0.4 可选本地垂直索引（已完成）

- 显式开启后，成功公开页面自动写入 SQLite FTS5；默认关闭，不进入爬虫主链路。
- `search_web` 支持 `auto`、`local` 和 `web`。
- 本地优先、外部补足、URL 去重与显式部分失败。
- 同一最终 URL 更新，不索引授权 Profile 内容。
- 无 SearXNG 时仍可搜索已经读取或抓取的本地语料。

## v0.5 持久异步抓取（已完成）

- SQLite 页级 Frontier、UUID、lease/heartbeat、owner + generation fencing 和 cursor publication。
- `start_crawl`、`get_crawl`、`get_crawl_pages`、`pause_crawl`、`resume_crawl`、`cancel_crawl` MCP 工具。
- 1–32 页并发、全局 Worker 容量、按 origin 持久启动间隔和 `Retry-After` cooldown。
- Crawl 累计 attempts、主文档字节、Browser 时间/Context 和 deadline 硬预算。
- 活动请求协作式取消；`SIGKILL` 后回收过期 lease，已提交页面不重抓。
- 普通 CLI 与长期服务 Worker 生命周期隔离。

## v0.6 域名策略与有界重试（已完成）

- 同 hostname 最小尝试间隔。
- 仅对 retryable 失败进行有界指数退避。
- 支持并尊重 `Retry-After`，超出预算时保留失败。
- 成功和最终失败包含尝试证据。
- 异步任务取消可打断退避等待。

## v0.7 管理员代理池（已完成）

- HTTP 与浏览器共享管理员配置的 HTTP(S) 代理池。
- 普通任务 round-robin，授权 Profile 稳定哈希绑定。
- HTTP 重定向链和浏览器上下文保持固定出口。
- URL policy、robots 和访问失败边界不因代理弱化。
- 结果只暴露代理使用布尔值，不泄露地址或凭证。

## v0.8 浏览器 Worker 池（已完成）

- 匿名页面复用有界 Chrome 实例。
- 每页独立 BrowserContext，限制每实例并发。
- 直连与代理出口分池，池满事件等待和超时。
- Crawl Job 取消可中断 lease 等待。
- 断连、启动失败与应用关闭释放容量。
- 授权 Profile 保持独占串行，不混入匿名池。

## v0.9 运行质量（已完成）

- 运行成功率、失败原因和可测量成本统计（已完成）。
- 基于正文 Hash 的变化检测和事件驱动定时监控（已完成）。

复杂内容质量评分、LLM Judge、Embedding 和跨页语义去重暂不进入核心路线。只有真实客户问题和成本收益证据足够时再单独评估。

## v0.10 身份与许可

- 公开 Agent 身份说明（已完成首版）。
- Web Bot Auth 签名（已完成 `cloudflare-legacy` HTTP 兼容档）。
- RSL Core 发现与保守策略（已完成首版）。
- OLP License Token 与 CAP 请求授权（已完成无付费许可首版）。
- 精确许可批准与用户确认边界（已完成首版）。
- 访问与内容使用审计（已完成首版）。
- 付费许可报价、禁用预算与不结算边界（已完成 fail-closed 首版；真实付款未启用）。

## v0.11 Reliability Truth

- 实现版本化 Case Schema、独立 Truth Evaluator、Controlled Site 和统一 `pnpm bench -- --mode ...` 入口（已完成）。
- 区分 `valid`、`uncertain`、`invalid`、`failed`、`policy_stop`、`unsupported` 和 `harness_error`（已完成）。
- PR 固定运行 46 个受控 Case×5；Nightly 增加 10 个未过期公开 Canary×5，并记录环境/配置指纹（已完成）。
- 记录 False Success、Cost per Valid Artifact、Browser Uplift、Retry Recovery/Waste，并支持同 Case Set
  Release 配对比较与确定性置信区间（已完成）。
- Release 只允许在同 Case Set、配置和环境证据下比较，不宣称无证据的竞品领先。

## v0.12 Access Planner 与 Attempt Ledger

- CLI、MCP、Reader 共用 `ReadIntent` 边界；`ExecutionBudget`、内容寻址 `AccessPlan`、统一
  `StageResult` 和三态 `ValidationResult` 合同已完成。
- Cache、HTTP、Browser、Feed、PDF 进入统一 Provider Registry；破坏性删除 `mode`，Adapter 默认
  unavailable，未知 Provider 明确失败（已完成）。
- append-only Attempt Ledger、request terminal、幂等 publication 和重启重放已完成；旧脱离运行路径的
  Job Service 已删除。
- Stage Executor 已从 Reader 拆出；Stage-level retry 不重复已成功阶段，全局 deadline、attempt、主文档
  bytes、Browser 时间和 Context 数量均以 `BUDGET_EXHAUSTED` 显式终止（每页与异步 Crawl 累计预算首版已完成）。
- Benchmark 成功、失败和策略停止均携带可复算 Plan + Attempt Ledger provenance；主文档 bytes 与
  Provider attempts 是代理成本，不宣称为全链路网络总量。
- 429/`Retry-After` 进入按 origin 调度，不通过身份轮换规避。
- `ReaderService.fetchWithMode` 与 `SiteService.shouldRender` 均已删除；Reader、Map、Crawl 统一提交 Intent，由确定性 Planner、Stage Executor 和 Attempt Ledger 执行。
- 46 个受控 Case 已覆盖格式、重定向、Retry、状态码、Policy Stop、Browser、超时、溢出和不完整内容。

## v0.13 Browser Readiness 与内容质量

- 用正文稳定、目标条件和硬预算替换固定浏览器等待（正文稳定、三策略 Tournament、生产
  Intent/Adapter selector 与预算化滚动首版已完成）。
- Browser/Context 健康、自动回收、失败 Trace 有界存储和敏感信息清理（已完成）。
- Extractor Registry、Validator Registry、JSON/RSS/Atom/Sitemap/JSON-LD/PDF 等确定性能力（已完成）。
- 同一 raw response 多 Extractor、不重复下载，以及 Raw/Artifact 内容寻址存储（已完成）。
- LLM 仍是条件式能力；当前没有 token 预算和必要性证据，因此未启用。

## v0.14 Durable Concurrent Crawl Engine（已完成本地 Profile）

- 页级持久 Frontier、lease、checkpoint、去重、中断恢复和分页 publication 已完成。
- HTTP、Browser、授权 Session 分池。
- HTTP、匿名 Browser、授权 Session 分池；有界 backpressure、origin delay、429/503 cooldown、Circuit
  Breaker 和有界自适应并发已完成。
- ETag/Last-Modified revalidation、singleflight、显式 stale-while-revalidate 和 Cache 清理已完成。
- cursor 结果、可解释部分失败和最多 30 秒的 publication wait 已完成；重连仍以 SQLite cursor 重放为准。

## v0.15 Optimization Loop 与 Adapter Gate（已完成）

- 离线 HTTP/Browser Shadow、Readiness A/B、Retry Counterfactual、Extractor Tournament 已由
  `pnpm bench:optimize` 实现；不采样生产流量、不在线自修改。
- 候选策略内容寻址，只有显式 review 才能 release，rollback 只能指向已发布祖先。
- 受信任 Site Adapter Registry、版本化 Schema、Fixture/Canary/Error Case ID、ROI Gate 和退役条件已完成。
- 当前通用 Nightly 280/280 Truth 通过且没有私有配对 Release 证据，因此默认 Registry 为空，不虚构
  首批具体站点 Adapter。

## v0.16 AI 工具与开发者文档自主垂直索引（已完成 Phase 1–5 本地合同）

- 官方 domain、人工精确 URL、SearXNG 候选三种来源统一持久化；白名单内候选自动准入，外部候选
  必须显式批准或拒绝。
- 每日增量复用 durable crawl job，硬限制为 600 个官方域名、300,000 个当前索引页面和每日
  60,000 次 Provider 尝试；同 UTC 日重复运行、满容量和无 seed 都显式失败。
- Raw CAS/Artifact 继续拥有原始内容，FTS5 拥有当前搜索投影，并按 content hash 记录处理版本审计。
- 固定 query judgment 强制本地查询，输出 Hit@10、Recall@10 和 MRR@10；SearXNG 不参与自主查询。
- 每次公开 publication 保存 URL 身份观察和历史 Raw/Artifact 引用；FTS 可离线重建，exact URL
  重抓顺序使用确定性的变化率与陈旧时间优先级。
- 检索候选可在同一 judgment 快照下与 lexical baseline 配对比较；发布门槛要求三项指标均不回退且
  至少一项提升，但不会自动切换生产 ranker。
- `search_web` 返回实际执行来源和查询前本地快照；只读 `get_search_status` 区分 ready 与 unavailable。
- 内容可验证的本地 release 支持显式激活和原子回滚；SQLite online backup 可校验并只恢复到新路径。
- `get_search_stats` 返回脱敏的查询结果、source、p50/p95/max 与失败原因，不硬编码 SLO 门槛。
- 真实 embedding/vector/reranker、自动 rollout、托管 HTTP API、分布式索引和开放 Web 仍由真实
  质量或容量证据触发。

## v0.17 本地合同补全（已完成）

- `extract_page` / `crawlume extract`：把已声明的 `ReadIntent.operation=extract` 接到 CLI 与 MCP，返回结构化 JSON；未知 `schemaId` 失败关闭。
- 本地 FTS 对含汉字且零命中的查询返回 `LEXICAL_LANGUAGE_MISMATCH` 警告，不提供翻译或跨语言改写。
- RSL RSS/Atom 模块发现与同进程内容 URL catalog。
- PDF、EPUB、常见图片和音频容器中的内嵌 RSL/XMP 作为 `file` 发现面执行；真实付款和站点 Adapter 仍未启用。
- 文档试用支持从官方域名首页发现语料；目标页未发现不计为索引命中。官方 domain 每日抓取深度 3；发现队列跳过图片、压缩包、脚本、样式、字体和音视频。
- `evidence.networkBytesIn` 计入 robots/RSL/重定向和浏览器子资源；页级 `maxDocumentBytes` 仍是主文档。浏览器主导航可发送 Web Bot Auth。

## 可选的托管服务外壳

可靠性核心和单位成本被 Benchmark 证明后，再按真实交付需求增加：

- 托管 API、最小 API Key、用量、客户数据隔离和 Webhook。
- SLA、运维手册和私有部署。
- 组织、SSO、RBAC、复杂控制台和账单不是当前核心，不能阻塞 v0.11-v0.14。

## 发布门槛

每个阶段都必须具备：稳定输入契约、显式失败、SSRF 与凭证隔离、聚焦测试、真实公开站点冒烟，
以及升级后不降低既有安全边界的证据。v0.11 起还必须报告同一 Benchmark Case Set 下的有效成功率、
错误成功率和单位有效结果成本；原始请求成功率不能单独作为发布证据。

机器判定 Gate 已实现 `experimental`、`canary-ready`、`release-candidate` 和
`production-proven` 四级。当前受控和公开证据达到 `canary-ready`；缺少私有 Release Case 与生产
rollout，不能描述为 `release-candidate`、`production-proven` 或优于竞品。
