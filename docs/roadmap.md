# Diaoyan 路线图

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

- SQLite 持久 Crawl Job 与 UUID。
- `start_crawl`、`get_crawl`、`cancel_crawl` MCP 工具。
- 单 Worker 无空轮询调度。
- 结构化成功、失败和页面级部分结果。
- 协作式取消与进程重启恢复。
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

- 实现 `docs/reliability-benchmark-spec.md` 的 Case Schema、Truth Evaluator 和 Controlled Site。
- 区分 `valid`、`uncertain`、`invalid`、`failed`、`policy_stop` 和 `unsupported`。
- 建立首个分层 Corpus 与可复现 baseline。
- 记录 False Success、Cost per Valid Artifact、Browser Uplift、Retry Recovery/Waste。
- Release 只允许在同 Case Set、配置和环境证据下比较，不宣称无证据的竞品领先。

## v0.12 Access Planner 与 Attempt Ledger

- `ReadIntent`、`ExecutionBudget`、`AccessPlan`、`StageResult` 和 `ValidationResult` 稳定合同。
- Cache、HTTP、Browser 变成 Provider；现有 `mode` 参数映射为 Provider allowlist。
- append-only Attempt Ledger 和可重放 projection。
- Stage-level retry，避免重复已经成功的 HTTP、Browser 或 Extraction 阶段。
- 429/`Retry-After` 进入按 origin 调度，不通过身份轮换规避。
- `ReaderService.fetchWithMode` 和 `SiteService.shouldRender` 收敛到唯一 Planner。

## v0.13 Browser Readiness 与内容质量

- 用正文稳定、目标条件和硬预算替换固定浏览器等待。
- Browser/Context 健康、自动回收、失败 Trace 抽样和敏感信息清理。
- Extractor Registry 与 Validator Registry。
- RSS、Sitemap、JSON-LD、PDF 等确定性能力。
- 同一 raw response 可运行多个 Extractor，不因抽取失败重复下载。
- LLM 仅作为显式、预算化的可选 uncertain 路径。

## v0.14 Durable Concurrent Crawl Engine

- 页级持久 Frontier、lease、checkpoint、去重和中断恢复。
- HTTP、Browser、授权 Session 分池。
- 全局资源预算和按 origin 自适应并发、backpressure、Circuit Breaker。
- ETag/Last-Modified revalidation、singleflight、stale-while-revalidate 和 Cache 清理。
- 流式页面结果和可解释部分失败。

## v0.15 Optimization Loop 与首批 Adapter

- HTTP/Browser Shadow、Readiness A/B、Retry Counterfactual、Extractor Tournament。
- Planner 策略版本、Benchmark 对照、review 和回滚。
- 只有通过使用量、失败成本和维护 ROI Gate 的站点才建立 Adapter。
- 每个 Adapter 有版本化 Schema、Fixture、Live Canary、错误 Case 和退役条件。

## 可选的托管服务外壳

可靠性核心和单位成本被 Benchmark 证明后，再按真实交付需求增加：

- 托管 API、最小 API Key、用量、客户数据隔离和 Webhook。
- SLA、运维手册和私有部署。
- 组织、SSO、RBAC、复杂控制台和账单不是当前核心，不能阻塞 v0.11-v0.14。

## 发布门槛

每个阶段都必须具备：稳定输入契约、显式失败、SSRF 与凭证隔离、聚焦测试、真实公开站点冒烟，
以及升级后不降低既有安全边界的证据。v0.11 起还必须报告同一 Benchmark Case Set 下的有效成功率、
错误成功率和单位有效结果成本；原始请求成功率不能单独作为发布证据。
