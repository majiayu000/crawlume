# Crawlume 可靠性与成本优化架构

状态：Approved and implemented（本地单机 Profile）；条件式集群、托管 Provider、模型和具体站点 Adapter 未启用
最后更新：2026-08-30
配套真值规范：[reliability-benchmark-spec.md](./reliability-benchmark-spec.md)

选型说明：跨项目架构调研和四方案决策见 [technology-selection-rfc.md](./technology-selection-rfc.md)。
本地模块化方案已经按 [architecture-completion-ledger.md](./architecture-completion-ledger.md) 落地；
本文描述已实现的边界和仍需外部证据触发的扩展，具体公共行为以 [spec.md](./spec.md) 为准。

## Objective

把 Crawlume 从“带 HTTP/Browser fallback 的本地 Reader”演进为高可靠 Web Retrieval Engine。在调用方
给定内容目标、新鲜度、延迟和成本预算后，系统选择最便宜的可靠访问路径，返回经过验证的 Artifact；
无法确认时返回 `uncertain` 或明确失败，禁止用错误内容制造高成功率。

总优化目标：让用户用更少资源得到更多可信结果。

```text
maximize   valid_artifacts
minimize   false_successes + total_execution_cost + valid_latency
subject to policy, authorization, freshness and resource budgets
```

## Current Evidence

| Area | Evidence | Implication |
| --- | --- | --- |
| Entrypoints | `src/mcp.ts`、`src/cli/main.ts`、`src/server.ts` | CLI/MCP 已共享应用核心，继续保持公共合同薄层 |
| Composition | `src/app.ts` 构造共享 Intent、Provider Registry、Stage Executor、Governor、Store、Frontier、Monitor 和 Metrics | 单一 composition root，不在 import 时启动隐藏 Worker |
| Access decision | `src/reliability/read-intent.ts` 与 `planner.ts` 生成内容寻址 Plan；Reader/Map/Crawl 共用 Stage Runtime | `fetchWithMode`、公开 `mode` 和 Site `shouldRender` 已删除 |
| Browser runtime | `src/runtime/readiness.ts`、`src/fetch/browser.ts`、`src/browser-pool.ts` 和 `src/browser-trace.ts` | 目标/正文稳定、预算化滚动、生命周期回收和脱敏失败 Trace 已完成 |
| Extraction | `src/extract.ts` 的确定性 Registry 支持 JSON、JSON-LD、RSS/Atom、Sitemap、PDF、Article、Document、Plain | 同 raw 多候选已完成；模型 Extractor 未启用 |
| Validation | `src/validation.ts` 的版本化 Registry 独占 `valid/uncertain/invalid` 判定 | Provider/Extractor 不再把候选直接声明为成功 |
| Crawl state | 同步 `src/site.ts` 保持有界串行；异步 Crawl 使用 SQLite 页级 Frontier、lease、fencing、并发 Worker 和 cursor publication | 单机首版已完成；多机权威 Frontier 尚未实现 |
| Retry/resources | `src/runtime/runtime-resource-governor.ts` + Frontier origin state + Stage retry | HTTP/Browser/Auth 分池、backpressure、429/503 cooldown、Circuit 和有界 AIMD 已完成 |
| Cache/store | `src/cache.ts` 的 immutable raw/artifact CAS 与 cache projection | 304、singleflight、显式 SWR、TTL/容量清理和授权隔离已完成 |
| Metrics | `src/metrics.ts` 投影最终状态、版本、Stage、transition、资源、Cache 与 Crawl coverage | 聚合不保存 URL、Profile、正文或 Trace 内容 |
| Tests | 52 个文件、463 个测试；PR 230/230、Nightly 280/280 Truth 通过；Optimization Loop 有独立报告 | 达到 `canary-ready`，仍不代表私有 Release 或生产 rollout |
| Adapter | `src/adapters.ts` 的受信 Manifest/Schema/ROI/retirement 合同 | 默认 Registry 为空；没有证据时不创建具体站点 Adapter |

## Reference Models Considered

| Reference | Borrow | Do not copy | Source |
| --- | --- | --- | --- |
| Scrapy | Scheduler/Downloader/Pipeline 分层、按域名 AutoThrottle、持久 Job 思路 | Python 生态形态、全部 middleware 扩展面、历史兼容复杂度 | [Architecture](https://docs.scrapy.org/en/master/topics/architecture.html)、[AutoThrottle](https://docs.scrapy.org/en/master/topics/autothrottle.html) |
| Crawlee | Request Manager、可恢复 Request、资源感知并发、Session 状态合同 | 身份轮换和反限制能力不作为产品目标；不引入其全套存储抽象 | [Introduction](https://crawlee.dev/js/docs/introduction)、[Request loaders](https://crawlee.dev/js/docs/next/guides/request-loaders) |
| Playwright | BrowserContext 隔离、locator/condition 自动等待、失败 Trace | browser-first、固定 sleep、把测试 Runner 当生产调度器 | [Auto-waiting](https://playwright.dev/docs/actionability)、[Trace Viewer](https://playwright.dev/docs/next/trace-viewer) |
| Crawl4AI | 内存感知 Dispatcher、流式多 URL 结果、URL 分类配置 | 默认对所有 URL 启动浏览器、把 LLM 放在所有页面热路径 | [Multi-URL Crawling](https://docs.crawl4ai.com/advanced/multi-url-crawling/) |
| Firecrawl | 简洁的 read/crawl/extract 表面、异步 Job、统一 Artifact | 云端规模基础设施、功能/定价表、未公开的内部实现假设 | [Crawl](https://docs.firecrawl.dev/features/crawl) |
| Browserbase | Session 与持久 Context 分离、可观测浏览器会话 | 托管浏览器产品本身、远程 Profile 作为默认凭证边界 | [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts) |

## Chosen Shape

项目形态：长运行 Web Retrieval Runtime，外加薄 CLI/MCP 产品层和可插拔 Provider/Extractor/Validator。

**唯一状态所有权模型：每个 Request 的真值由 append-only `ExecutionAttemptLedger` 拥有；Scheduler
只拥有排队权，Provider 只产生不可变 Stage Result，Artifact Store 只保存已验证的不可变 Artifact
及其投影。**

```text
product/app
  - CLI、MCP、未来可选 HTTP API
  - 把输入转换为 ReadIntent；把 typed error 转换为用户响应

core/domain
  - ReadIntent、AccessPlan、Stage、Artifact、Validation、Budget、TypedError
  - 纯决策规则；不得访问网络、SQLite、浏览器、环境变量

runtime/application
  - Planner、Executor、AttemptLedger、Frontier、ResourceGovernor
  - 拥有请求生命周期、重试、升级、取消、恢复和关闭

adapters/backends
  - Cache、HTTP、Browser、Feed、PDF Provider
  - SQLite Store、Clock、Trace、Cost Meter

plugins/components
  - Versioned Site Adapter、Extractor、Validator
  - 显式 host/capability/schema/lifecycle，不是任意脚本逃生口

testing/headless
  - Fake Provider、Controlled Site、Benchmark Harness、contract tests
```

TypeScript 暂无该 Skill 的语言专项参考，本设计直接应用上述通用边界，不先拆 npm package。

## Boundary Map

当前实现位置：

```text
src/types.ts             # Intent、Plan、Stage、Validation、Usage 合同
src/reliability/
  read-intent.ts         # CLI/MCP/Reader 共享归一化边界
  planner.ts             # 纯 AccessPlan 决策

src/extract.ts           # 确定性 Extractor Registry
src/validation.ts        # Validator Registry 和组合规则
src/cache.ts             # raw/artifact CAS 与 cache projection
src/jobs.ts              # append-only Attempt 与 request terminal
src/adapters.ts          # 受信 Site Adapter 与 ROI Gate
src/browser-trace.ts     # 脱敏、有界失败 Trace

src/runtime/
  executor.ts           # 按 plan 执行 stage
  frontier.ts           # 页级耐久队列
  providers.ts          # 统一 Provider Stage Registry
  resource-governor.ts  # Crawl 累计硬预算
  runtime-resource-governor.ts # HTTP/Browser/Auth 容量与反馈控制
  readiness.ts          # Browser readiness runtime

benchmarks/
  schema/
  cases/
  harness/
  controlled-site/
```

`ReaderService` 仍是公共 Facade。Reader、Map、Crawl 已统一委托确定性 Planner 并按 Stage 执行；
Site 只维护有界 BFS、范围和逐页部分失败，不再拥有访问升级 heuristic。

## Core Contracts

### ReadIntent

```ts
type ReadIntent = {
  url: string;
  operation: "read" | "inspect" | "map" | "crawl" | "extract";
  output: { format: "markdown" | "json"; schemaId?: string };
  freshness: { maxAgeSeconds: number; allowStaleWhileRevalidate: boolean };
  authorization: { profileId: string | null; allowedOrigins: string[] };
  completion: { type: "content" | "discovery" } | DomCompletion;
  budget: ExecutionBudget;
};
```

调用方声明目标、Browser 是否允许、完成条件和预算，不声明内部必须使用哪个实现。旧
`mode=auto|http|browser` 已按破坏性变更删除，不保留兼容层。

### ExecutionBudget

```ts
type ExecutionBudget = {
  deadlineMs: number;
  maxAttempts: number;
  maxDocumentBytes: number;
  maxBrowserMs: number;
  maxBrowserContexts: number;
  maxOptionalModelTokens: number;
};
```

预算是硬边界。超出预算返回 `BUDGET_EXHAUSTED`，不得 warning 后继续消耗。Map/Crawl 当前把调用方
同步 Map/Crawl 仍把预算独立应用到每个页面；异步 Crawl 另有持久化累计 `CrawlBudget`，在 claim
事务中 reservation、完成后 settlement/refund，并为每页生成唯一 requestId。首版
`maxDocumentBytes` 只累计 Provider 返回的主文档字节；robots、RSL、重定向响应和 Browser 子资源尚未
纳入，因此不得把它解释成全链路网络流量。需要总流量预算时，计量必须继续下推到 Transport 和
Browser network events。

### AccessPlan

```ts
type AccessPlan = {
  id: string;
  plannerVersion: string;
  stages: PlannedStage[];
  terminalConditions: TerminalCondition[];
};

type PlannedStage = {
  id: string;
  provider: "cache" | "http" | "browser" | "feed" | "pdf" | "adapter";
  runWhen: StagePredicate;
  retryPolicy: RetryPolicy;
  budgetSlice: ExecutionBudget;
};
```

P0 Planner 使用确定性规则。历史域名统计只能作为有版本的输入事实，不能在运行中静默改变策略。

### StageResult

```ts
type StageResult = {
  stageId: string;
  outcome: "succeeded" | "failed" | "stopped" | "cancelled";
  rawRef: string | null;
  traceRef: string | null;
  candidateArtifactRef: string | null;
  error: TypedReadError | null;
  usage: ResourceUsage;
  startedAt: string;
  completedAt: string;
};
```

Provider 不得写最终成功状态，不得自行选择下一个 Provider；它只返回 StageResult，由 Executor 追加
Ledger 事件并让 Planner/Validator 决定下一步。

### ValidationResult

```ts
type ValidationResult = {
  outcome: "valid" | "uncertain" | "invalid";
  validatorVersion: string;
  checks: ValidationCheck[];
};
```

`valid` 必须由内容类型或 Adapter 声明的必需检查构成。`uncertain` 可以返回给用户，但不得计入
Valid Result Rate，也不得写成 `completeness=complete`。

## Request Lifecycle

```text
accepted
  -> planned
  -> queued
  -> running(stage N)
       -> stage_succeeded -> validating
       -> stage_failed    -> retry_wait | replanned | terminal_failed
       -> policy_stop     -> terminal_stopped
       -> cancelled       -> terminal_cancelled
  -> artifact_valid       -> completed
  -> artifact_uncertain   -> completed_uncertain
  -> artifact_invalid     -> replanned | terminal_failed
```

每次状态变化追加事件；Projection 提供当前状态。进程恢复时从最后一个已提交事件继续，禁止通过
“所有 running 重置 queued”丢失已完成 Stage 的证据。

## Planner Policy

默认通用计划：

```text
1. versioned cache lookup
2. HTTP fetch -> registered site adapter when an eligible exact-host adapter exists
3. otherwise route the same raw response through format/article/document extractors
4. validate every candidate independently
5. Browser fetch only when validation proves rendering/interaction is needed
6. rerun adapter/extractors on the Browser raw response without duplicate fetches
7. explicit uncertain/failure/policy stop
```

Planner 选择候选计划时最小化预测的单位有效结果成本：

```text
expected_score(plan) =
  predicted_valid_probability(plan) * value
  - predicted_resource_cost(plan)
  - false_success_risk(plan) * risk_penalty
  - deadline_overrun_risk(plan) * latency_penalty
```

P0 的预测值来自静态规则和 Benchmark；P2 才允许使用按页面类别聚合的历史统计。不要在没有真值
反馈时构建“智能 Planner”。

## Stage-level Retry Contract

| Failure class | Owner | Default action | Forbidden action |
| --- | --- | --- | --- |
| transient network/5xx | 当前 Provider + Executor | 同 Stage 有界重试和 jitter | 重跑已成功的前序 Stage |
| 429/Retry-After | Origin Scheduler | 暂停该 origin，其他 origin 继续 | 立即轮换身份规避限速 |
| HTTP shell/incomplete | Planner | 升级 Browser | 重复相同 HTTP 直到预算耗尽 |
| extraction invalid | Extractor Registry | 对同一 rawRef 尝试下一 extractor | 重新下载相同响应 |
| browser crash | Browser Provider | 新 Context/Browser 后重试当前 Stage | 删除授权 Profile 或换账号 |
| login/payment/human check | Policy boundary | 停止或人工 checkpoint | 自动绕过 |
| unsupported type | Planner | 对应 Provider 或显式 unsupported | 当空正文成功返回 |

Attempt Ledger 必须记录每次尝试的 provider、stage、错误、等待、资源和前置结果引用。

## Browser Readiness Contract

浏览器 Provider 不再固定 sleep。ReadinessPolicy 是版本化、可测试的组合：

- 主响应完成且最终 URL 通过策略校验。
- Adapter 目标 selector/role 已出现。
- Loading/Skeleton 信号消失。
- 候选正文长度达到阈值。
- 候选内容 Hash 在连续采样窗口稳定。
- 已知关键请求完成，或达到允许的 network quiet 条件。
- Deadline/Browser budget 到期时明确返回 `FETCH_TIMEOUT`。

Generic Policy 只用保守 DOM/正文稳定条件；目标 selector/字段断言来自 Intent 或 versioned Adapter。
scroll/click 等 InteractionPolicy 必须显式声明 scope、终态和预算，Generic Policy 不主动交互。图片、
字体、媒体等资源过滤也只能由明确 Capability 声明，避免为了省成本破坏内容。

首轮 5×5 受控 Tournament 中，fixed/adaptive/target 的 Valid Rate 分别为 40%/60%/100%，False Success
分别为 60%/20%/0%。全页正文稳定解决了延迟正文与 Skeleton，但持续变化页面会超时、无限滚动会在
首批内容稳定后假成功；因此它是 fallback，不是最终完成语义。

失败 Trace 默认抽样或只在失败时生成，包含有界 DOM snapshot、网络摘要、Console 摘要和 timing；
不得记录 Cookie、Authorization、个人消息或完整敏感页面。

## Extraction And Validation

Extractor 负责“候选数据”，Validator 负责“是否满足用户目标”，两者不得合并成一个成功布尔值。

```text
Content-Type Router
  -> JSON / Feed / Sitemap / JSON-LD / PDF
  -> Generic Article Readability
  -> Clean Document
  -> Matching Site Adapter
  -> explicit unsupported
```

同一 rawRef 可以运行多个廉价 Extractor，避免重复 Fetch。Adapter 必须声明：

- `id`、`version` 和精确 HTTPS host。
- 显式 capability 与版本化输出 Schema。
- Fixture、Live Canary、错误 Case 的稳定 ID。
- 评估窗口、使用量/净收益门槛、官方结构化源和退役条件。

LLM 只允许作为显式、预算化、可替换的可选 Extractor/Validator，默认不进入热路径；模型不可用时
必须返回明确错误或使用已声明的确定性路径，禁止 silent degradation。

## Durable Frontier And Concurrency

页级 `FrontierRequest` 是并发和恢复的最小单位：

```ts
type FrontierRequest = {
  id: string;
  crawlId: string;
  normalizedUrl: string;
  depth: number;
  discoveredFrom: string | null;
  priority: number;
  state: "queued" | "leased" | "succeeded" | "failed" | "stopped";
  nextEligibleAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
};
```

Runtime ResourceGovernor 同时执行：

- HTTP、匿名 Browser Context 和授权 Session 分池；授权 Profile 保持串行。
- 每 origin 并发、最小间隔、延迟反馈、429/503 暂停和 Circuit Breaker。
- HTTP Queue 与 Browser Queue 分池，避免浏览器慢任务阻塞静态页面。
- 等待队列固定有界且可取消；同步 Artifact/SQLite 阶段通过事件循环对 intake 形成 backpressure。
- AIMD 式渐进扩容，retryable failure 或延迟恶化时快速收缩。

它不采集 CPU、RSS、文件描述符或系统负载，也不声称跨进程协调；Crawl 累计硬预算由
`src/runtime/resource-governor.ts` 单独负责。

P0 仍是单进程 SQLite Worker；先把页级状态和租约做正确，再考虑多进程。多租户、组织和分布式
消息系统不是可靠性核心，也不进入本架构 P0/P1。

## Cache And Reuse

Artifact cache key 至少包含：规范化 URL、ReadIntent 输出、授权范围、Adapter/Extractor/Validator
版本和许可上下文 Hash。

已实现：

- ETag/Last-Modified 条件请求。
- 同 key in-flight singleflight。
- Stale-while-revalidate，但陈旧结果必须显式标记。
- raw response 与 validated artifact 分离，允许复用 rawRef 重跑新 Extractor。
- 容量、TTL 与无引用 raw/artifact 清理；不保留旧 Schema 兼容迁移。
- 授权内容默认不进入共享 cache 或索引。

## Observability And Optimization Loop

每次请求生成 requestId 并追加 Stage Attempt；只有 Browser 失败才生成不可猜测的本地 `traceRef`。聚合至少记录：

- Planner/Provider/Adapter/Extractor/Validator 版本。
- Provider、Extraction、Validation 与端到端阶段耗时。
- 主文档字节、请求输出字节、Browser ms、Context 启动、模型 token 和重试等待。
- 每次 Provider transition 的原因。
- 最终 `valid/uncertain/invalid/failed/policy_stop`。
- Cache hit/revalidation 和 Crawl coverage/duplicate。

生产 Validator 不是最终真值。Benchmark/Shadow 的独立 Truth Evaluator 将标签反馈为聚合统计：

```text
Benchmark truth -> strategy evaluation -> reviewed policy version -> release
```

禁止线上指标直接自我修改 Planner。策略变化必须形成版本、Benchmark 对照和可回滚发布。

## Source Of Truth And Migration Debt

| Contract | Current source of truth | Consumers | Duplicate/fork | Action |
| --- | --- | --- | --- | --- |
| Public MCP/CLI input | `src/mcp.ts`、`src/cli/main.ts` + `src/reliability/read-intent.ts` | Agent、CLI、Reader | 传输 Schema 独立，语义归一化唯一 | 保持入口薄层 |
| Access policy | `src/reliability/planner.ts` | Reader、Site | 无第二套 Site heuristic | 保持 Site 只提交 Intent |
| Content gate detection | `src/validation.ts` | Stage Executor | Extractor 只产候选 | 保持版本化 checks |
| Request retry/resources | Planner Stage policy + `src/crawl-policy.ts` + Runtime Governor + persisted origin state | Reader、Site、Frontier Worker | 单机容量与持久 origin 时序分工明确 | 多机才引入外部协调 |
| Crawl state | `src/frontier-store.ts` + `src/runtime/frontier.ts` | MCP Job | 页级 Frontier 是规范源，Job 为 projection | 多机时迁移 PostgreSQL lease |
| Cache | `src/cache.ts` | Reader/Index | raw/artifact 与 projection 已分离 | 保持授权/许可隔离 |
| Runtime metrics | `src/metrics.ts` | CLI/MCP stats | Benchmark truth 保持独立合同 | 不把生产 Validator 当最终真值 |
| Architecture docs | `spec.md`、本文、Benchmark Spec、完成账本 | 用户/维护者 | 历史 handoff 不作为当前事实 | 每个目标验证后同步 |

## Boundary Contracts

| Contract | Owner | Allowed dependencies | Forbidden dependencies | Tests |
| --- | --- | --- | --- | --- |
| State ownership | AttemptLedger/Frontier | Store interface、Clock | Provider 直接改 Job 状态；隐藏 globals | event replay、lease recovery tests |
| Lifecycle | Runtime composition root | Provider init/close、worker drain | import 时启动 Worker；无界后台任务 | startup/shutdown/drain tests |
| Planning | `core/domain` Planner | immutable facts、Benchmark-derived policy | 网络、SQLite、浏览器、环境变量 | deterministic plan table tests |
| Effects/IO | Provider/Store adapters | undici、Playwright、SQLite | core/domain 发请求或写库 | fake-provider no-IO contract tests |
| Errors | Typed stage/domain errors | boundary mapping | string matching；warning+错误成功 | error transition matrix tests |
| Validation | Validator Registry | CandidateArtifact、schema | 直接发网络请求；自行重抓 | fixture/adapter contract tests |
| Config/resources | composition root + ResourceGovernor | env at startup、typed Config | Provider 任意读 env；无预算执行 | config completeness、budget exhaustion tests |
| Observability | AttemptLedger events + projections | redacted resource facts | Cookie、Token、敏感正文、代理地址 | redaction、aggregation tests |
| Compatibility/API | Reader Facade | new Runtime contracts | 新旧 auto policy 同时长期存在 | existing Reader/MCP/CLI tests + parity tests |

## Breaking Convergence And Deletion Plan

| Path/shim | Why | Owner | Keep until | Delete/converge when |
| --- | --- | --- | --- | --- |
| `mode=auto/http/browser` | 旧 CLI/MCP 公共合同 | Reader Facade | 已删除 | 完成；使用 `browserAllowed`、completion 和 budget |
| `ReaderService.fetchWithMode` | 旧 auto policy | Reliability migration | 已删除 | 完成；single-page 委托 Planner Stage |
| `SiteService.shouldRender` | Map 独立 fallback | Site migration | 已删除 | 完成；Map 使用 `completion=discovery` |
| `CrawlRequestPolicy.execute` | 对 retryable 错误提供公开时序策略 | Runtime | 保留 | Governor 负责容量，Policy 负责每 Stage retry 时序 |
| Job 级 `running -> queued` 恢复 | 已删除 | Frontier migration | 页级 lease/replay 与真实 SIGKILL 测试已通过 | 完成；仅回收过期 page lease |
| 原 PageCache JSON blob | 已由 raw/artifact CAS 替代 | Store | 已删除 | 旧 Schema 明确不兼容，不增加迁移垫片 |

## Validation Matrix

| 层 | 要证明什么 | 验证 |
| --- | --- | --- |
| Core unit | Planner、预算、状态转换确定性 | `pnpm test -- tests/reliability-planner.test.ts tests/attempt-ledger.test.ts` |
| Provider contract | 相同错误/取消/usage 合同 | `pnpm test -- tests/provider-contract.test.ts` |
| Extractor/Validator | 同 rawRef 多策略、真值独立 | `pnpm test -- tests/extractor-registry.test.ts tests/validation.test.ts` |
| Runtime integration | fallback、Stage retry、singleflight、budget | `pnpm test -- tests/reliability-runtime.test.ts` |
| Browser headless | adaptive readiness、回收、Trace redaction | `pnpm test -- tests/browser-readiness.test.ts tests/browser-pool.test.ts tests/browser-trace.test.ts` |
| Crawl recovery | lease、中断、去重、backpressure | `pnpm test -- tests/frontier-store.test.ts tests/e2e/crawl-recovery.e2e.test.ts tests/e2e/crawl-scale.e2e.test.ts` |
| Benchmark | Valid/Invalid/Cost 可重复 | `pnpm bench -- --mode pr` |
| Breaking API | CLI/MCP/Reader 新合同一致且旧 `mode` 不再存在 | `pnpm check && pnpm test` |

## P0/P1/P2 Completion

| Priority | Work | Files/modules | Done when | Verification |
| --- | --- | --- | --- | --- |
| P0 | Benchmark Schema、Truth Evaluator、Controlled Site（完成） | `benchmarks/` | 46 个受控 Case×5 | `pnpm bench -- --mode pr` |
| P0 | Reliability contracts 与 Attempt Ledger（Reader/Map/Crawl 首版已完成） | `src/types.ts`、`src/jobs.ts`、`src/app.ts`、`src/reader.ts` | Provider 调用与 Ledger attempt 一一对应 | `pnpm test -- tests/attempt-ledger.test.ts tests/reliability-runtime.test.ts tests/site.test.ts` |
| P0 | Deterministic Access Planner（Reader/Map/Crawl 已完成） | `src/reliability/planner.ts` | Plan 内容寻址、可解释，content/discovery/DOM/Auth/预算路径确定 | `pnpm test -- tests/reliability-planner.test.ts` |
| P1 | Stage Executor 与细粒度重试（每页首版已完成） | `src/runtime/executor.ts` | 不重复成功 Stage；deadline、attempt、主文档字节和 Browser 预算显式失败 | `pnpm test -- tests/reliability-runtime.test.ts tests/site.test.ts` |
| P1 | Composable Browser Readiness（首版已完成） | `src/runtime/readiness.ts`、Browser Provider、公开 Read Intent | Intent/Adapter 目标条件优先，Generic 稳定兜底，滚动有预算 | `pnpm test -- tests/browser-readiness.test.ts tests/readiness-tournament.test.ts && pnpm bench:readiness` |
| P1 | Extractor/Validator Registry（完成） | `src/extract.ts`、`src/validation.ts` | 确定性多候选与三态验证 | registry contracts + Benchmark |
| P1 | Artifact Store revalidation/singleflight（完成） | `src/cache.ts` | 相同请求合并、304、SWR、版本隔离 | `tests/cache-reuse.test.ts`、`tests/storage.test.ts` |
| P2 | Durable Frontier 与 ResourceGovernor（完成本地 Profile） | `src/runtime/frontier.ts`、两个 governor | 恢复、按 origin 调节、HTTP/Browser/Auth 分池 | recovery/load tests |
| P2 | Shadow 与策略发布闭环（完成离线 Profile） | `benchmarks/optimization/` | 策略有版本、对照、审批和回滚 | `pnpm bench:optimize` |
| P2 | Site Adapter 合同与 ROI Gate（完成；无具体站点） | `src/adapters.ts` | 只有合格配对证据才能注册 | `tests/adapter-contract.test.ts` |

## Exploration Program

按假设运行实验，不按“功能看起来不错”实施：

1. HTTP/Browser Shadow：已在匿名受控 Case 离线运行，不采样生产流量。
2. Readiness A/B：已复用 5 Case×3 策略×5 次真实 Chrome Tournament。
3. Retry Counterfactual：已从 Nightly append-only Attempt 离线比较 no-retry/one-retry/current。
4. Extractor Tournament：已在同 rawRef 比较 Article/Document 独立 Truth。
5. Concurrency Sweep：在同 Corpus 上逐级提高全局/每 origin 并发，寻找成本和 p95 拐点。
6. Cache Revalidation：比较 full fetch、conditional fetch、stale-while-revalidate 的新鲜度与成本。
7. Adapter ROI：Gate 已实现；当前没有满足条件的具体站点。
8. Optional Model Gate：仅对 uncertain 样本调用模型，比较有效提升和 token 成本。

每个实验必须预先写假设、主要指标、护栏指标、停止条件和结果；记录位置见
[reliability-exploration-log.md](./reliability-exploration-log.md)。

## Non-Goals

- P0/P1 不做多租户、组织、SSO、账单或复杂控制台。
- 不以隐藏身份、验证码处理或访问控制规避提升成功率。
- 不承诺全网通吃；按 Corpus 类别声明能力。
- 不默认 browser-first 或 LLM-first。
- 不在真值反馈闭环之前做自动自学习 Planner。
- 不为了模仿 Firecrawl/Crawlee 引入 Redis、RabbitMQ 或微服务。

## Open Questions

- `uncertain` 是否默认返回正文，还是要求调用方显式允许？
- 首批结构化 Adapter 选择 X、文档站、商品列表还是另一垂直？
- 私有 Release Corpus、真实工作负载权重和生产 rollout 由谁提供与审核？

## Readiness

本地模块化 Profile 的合同、Ledger/Store、Provider/Extractor/Validator、Frontier/Governor、Metrics、
Benchmark、离线 Optimization Loop 与 Adapter ROI Gate 已实现并有完成账本证据。当前机器 Gate 为
`canary-ready`；私有 Release、生产 rollout、竞品对照、具体站点 Adapter、远程 Provider、集群和模型
能力没有证据或未触发，不能描述为生产级可靠性、竞品等价或全网最高成功率。
