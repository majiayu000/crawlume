# Diaoyan 可靠性与成本优化架构

状态：Architecture Foundation，Benchmark/Readiness 首版与 Contracts/Attempt Ledger 基础切片已实现
最后更新：2026-08-29
配套真值规范：[reliability-benchmark-spec.md](./reliability-benchmark-spec.md)

选型说明：本文描述的是较早形成的候选组件设计。跨项目架构调研和四方案决策见
[technology-selection-rfc.md](./technology-selection-rfc.md)；RFC 仍为 Proposed，批准后应以其决策为准
统一本文，不能把两份目标文档同时当作已实现事实。

## Objective

把 Diaoyan 从“带 HTTP/Browser fallback 的本地 Reader”演进为高可靠 Web Retrieval Engine。在调用方
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
| Composition | `src/app.ts` 构造 HTTP、Browser、Cache、Job、Monitor、Metrics | 当前依赖组装清晰，适合渐进加入 Planner/Runtime，不需要先拆包 |
| Access decision | `src/reader.ts` 仅支持 `auto/http/browser`，`auto` 只在 `SHELL_ONLY`/`INCOMPLETE_CONTENT` 时回退 | Access Planner 是边界补全，不应在 Reader 中继续堆条件分支 |
| Browser runtime | `src/runtime/readiness.ts` 与 `src/fetch/browser.ts` 已支持正文稳定兜底、目标 selector、attached/visible、预算化滚动、总预算硬超时和 readiness 证据 | 更多交互类型、站点 Adapter 策略和完整阶段 Trace 仍待实现 |
| Extraction | `src/extract.ts` 使用 JSON/plain、Readability、Document fallback | 缺少 content-type/站点 Extractor Registry |
| Validation | `src/validation.ts` 只检查字数和 fallback 方法 | 当前 `ok` 不能等同语义有效，需要独立 Validator Contract |
| Crawl state | `src/site.ts` 内存 BFS、串行执行；`src/jobs.ts` 持久化整项 Job | Job 可恢复但页级 Frontier 不耐久，无法安全提高并发 |
| Retry | `src/crawl-policy.ts` 对整个 operation 重试 | 需要 Stage-level Attempt Ledger，避免重复已成功阶段 |
| Cache | `src/cache.ts` TTL SQLite cache | 缺少 revalidation、singleflight、版本化 Artifact key 和清理 |
| Metrics | `src/metrics.ts` 记录请求、错误码、bytes、attempt、duration | 是良好起点，但缺少有效真值、阶段耗时、浏览器成本和 Planner 路径 |
| Tests | `tests/` 有 26 个测试文件、246 条测试，含独立 Browser readiness runtime、Intent/Adapter 传递与 Tournament truth 测试 | 新边界必须保持 headless/fake adapter 测试能力 |
| Repo state | 2026-08-28 `main` at `074ac92`，无仓库级 AGENTS/CLAUDE 指令 | 本 Spec 以当前主线为证据，不声称远端或未来实现状态 |

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

建议渐进目录，不要求一次性移动现有代码：

```text
src/reliability/
  contracts.ts          # 纯类型和 invariant
  planner.ts            # 纯 AccessPlan 决策
  validation.ts         # Validator Registry 和组合规则
  cost.ts               # ResourceUsage、CostModel

src/runtime/
  executor.ts           # 按 plan 执行 stage
  attempt-ledger.ts     # 事件追加与 projection
  frontier.ts           # 页级耐久队列
  resource-governor.ts  # 全局与按 origin 的资源控制
  readiness.ts          # Browser readiness runtime

src/providers/
  cache.ts
  http.ts
  browser.ts
  feed.ts
  pdf.ts

src/adapters/
  registry.ts
  generic-article.ts
  ...                   # 后续经 Benchmark 证明价值后增加

benchmarks/
  schema/
  cases/
  harness/
  controlled-site/
```

迁移期间现有 `ReaderService` 仍是公共 Facade，内部逐步委托 Planner/Executor；不要同时维护两个
`auto` 决策源。

## Core Contracts

### ReadIntent

```ts
type ReadIntent = {
  url: string;
  operation: "read" | "inspect" | "map" | "crawl" | "extract";
  output: { format: "markdown" | "json"; schemaId?: string };
  freshness: { maxAgeSeconds: number; allowStaleWhileRevalidate: boolean };
  authorization: { profileId: string | null; allowedOrigins: string[] };
  budget: ExecutionBudget;
};
```

调用方声明目标和预算，不声明内部必须使用哪个实现。兼容期保留 `mode=http|browser`，将其映射为
Provider allowlist。

### ExecutionBudget

```ts
type ExecutionBudget = {
  deadlineMs: number;
  maxAttempts: number;
  maxNetworkBytes: number;
  maxBrowserMs: number;
  maxBrowserContexts: number;
  maxOptionalModelTokens: number;
};
```

预算是硬边界。超出预算返回 `BUDGET_EXHAUSTED`，不得 warning 后继续消耗。

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
  candidateArtifact: CandidateArtifact | null;
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
2. matching adapter plan, when one exists
3. feed/json/json-ld/pdf capability route
4. HTTP fetch -> extract -> validate
5. Browser fetch only when validation proves rendering/interaction is needed
6. alternate extractor on the same raw response before refetch
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
- Deadline/Browser budget 到期时明确返回 `READINESS_TIMEOUT`。

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

- `id`、`version`、匹配 host/path/content-type。
- 支持的 operation 和输出 Schema。
- 需要的 Provider/Readiness 能力。
- 必需与禁止 Validation checks。
- Fixture、Live Canary、错误 Case。
- 退役和回退条件。

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
  state: "queued" | "leased" | "completed" | "failed" | "stopped";
  nextEligibleAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
};
```

ResourceGovernor 同时执行：

- 全局 HTTP、Browser Context、内存、CPU、文件描述符和数据库写入预算。
- 每 origin 并发、最小间隔、延迟反馈、429/503 暂停和 Circuit Breaker。
- HTTP Queue 与 Browser Queue 分池，避免浏览器慢任务阻塞静态页面。
- Backpressure：下游 Artifact/DB 写入变慢时停止领取新任务。
- AIMD 式渐进扩容，错误率、p95 或内存恶化时快速收缩。

P0 仍是单进程 SQLite Worker；先把页级状态和租约做正确，再考虑多进程。多租户、组织和分布式
消息系统不是可靠性核心，也不进入本架构 P0/P1。

## Cache And Reuse

Artifact cache key 至少包含：规范化 URL、ReadIntent 输出、授权范围、Adapter/Extractor/Validator
版本和许可上下文 Hash。

逐步加入：

- ETag/Last-Modified 条件请求。
- 同 key in-flight singleflight。
- Stale-while-revalidate，但陈旧结果必须显式标记。
- raw response 与 validated artifact 分离，允许复用 rawRef 重跑新 Extractor。
- 容量、TTL、LRU/清理和 schema migration。
- 授权内容默认不进入共享 cache 或索引。

## Observability And Optimization Loop

每次请求生成一个 trace ID，Stage Event 至少记录：

- Planner/Provider/Adapter/Extractor/Validator 版本。
- Queue wait、HTTP、Browser、Extraction、Validation 分阶段耗时。
- 网络字节、Browser ms、Context 启动、CPU、峰值内存和重试。
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
| Public MCP/CLI input | `src/mcp.ts`、`src/cli/main.ts` | Agent、CLI | 两层参数映射是 intentional bridge | 引入共享 ReadIntent parser，保持旧参数兼容 |
| Auto access policy | `src/reader.ts` | Reader、Site | `src/site.ts::shouldRender` 是 accidental fork | 收敛到 Planner；Site 只提交 Intent |
| Content gate detection | `src/extract.ts` | Reader | Site 内另有 shell heuristic | 收敛到 Validator/Planner evidence |
| Request retry | `src/crawl-policy.ts` | Reader、Site | operation 粒度过粗 | 迁移 Stage Retry 后删除旧 wrapper |
| Crawl state | `src/jobs.ts` 整 Job + `src/site.ts` 内存 Queue | MCP Job | 两级状态无法页级恢复 | Frontier 成为页级规范源，Job 做 projection |
| Cache | `src/cache.ts` | Reader/Index | raw/artifact 未分离 | 版本化 Artifact Store + rawRef |
| Runtime metrics | `src/metrics.ts` | CLI/MCP stats | Benchmark truth 不存在 | 运行遥测与 Benchmark truth 分库/分合同 |
| Architecture docs | 本文与 Benchmark Spec | Roadmap/实现任务 | `docs/spec.md` 是现状合同 | `spec.md` 继续描述已实现；本文描述目标架构 |

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

## Compatibility And Deletion Plan

| Path/shim | Why | Owner | Keep until | Delete/converge when |
| --- | --- | --- | --- | --- |
| `mode=auto/http/browser` | 现有 CLI/MCP 公共合同 | Reader Facade | ReadIntent Provider allowlist 稳定 | 只删除内部分支，不破坏参数 |
| `ReaderService.fetchWithMode` | 当前 auto policy | Reliability migration | Planner parity Case 全通过 | 委托 Executor 后删除内部决策 |
| `SiteService.shouldRender` | Map 独立 fallback | Site migration | Map 也走 Planner | 删除重复 heuristic |
| `CrawlRequestPolicy.execute` | 当前 operation retry | Runtime migration | Stage retry 覆盖现有 Case | 收敛为 Origin Governor + Stage Retry |
| Job 级 `running -> queued` 恢复 | 当前中断恢复 | Frontier migration | 页级 lease/replay 测试通过 | Job 改 projection，不再整项重置 |
| 原 PageCache JSON blob | 当前 TTL cache | Store migration | versioned Artifact Store 可迁移读取 | 迁移完成且旧行 TTL 到期 |

## Validation Matrix

| 层 | 要证明什么 | 验证 |
| --- | --- | --- |
| Core unit | Planner、预算、状态转换确定性 | `pnpm test -- tests/reliability-planner.test.ts tests/attempt-ledger.test.ts` |
| Provider contract | 相同错误/取消/usage 合同 | `pnpm test -- tests/provider-contract.test.ts` |
| Extractor/Validator | 同 rawRef 多策略、真值独立 | `pnpm test -- tests/extractor-registry.test.ts tests/validator-registry.test.ts` |
| Runtime integration | fallback、Stage retry、singleflight、budget | `pnpm test -- tests/reliability-runtime.test.ts` |
| Browser headless | adaptive readiness、回收、Trace redaction | `pnpm test -- tests/browser-readiness.test.ts` |
| Crawl recovery | lease、中断、去重、backpressure | `pnpm test -- tests/frontier.test.ts tests/crawl-recovery.test.ts` |
| Benchmark | Valid/Invalid/Cost 可重复 | `pnpm bench --mode pr` |
| Existing compatibility | 旧 CLI/MCP/Reader 行为不回归 | `pnpm check && pnpm test` |

## P0/P1/P2 Roadmap

| Priority | Work | Files/modules | Done when | Verification |
| --- | --- | --- | --- | --- |
| P0 | Benchmark Schema、Truth Evaluator、Controlled Site | `benchmarks/` | 产生首个可复现 baseline | `pnpm bench --mode pr` |
| P0 | Reliability contracts 与 Attempt Ledger（基础切片已完成） | 当前位于 `src/types.ts`、`src/jobs.ts`；待保护阈值解除后机械拆分 | 事件重放得到同一 projection；接入 Reader 前保持独立 | `pnpm test -- tests/attempt-ledger.test.ts` |
| P0 | Deterministic Access Planner | `src/reliability/planner.ts` | 现有 auto 行为可表达，Plan 可解释 | `pnpm test -- tests/reliability-planner.test.ts` |
| P1 | Stage Executor 与细粒度重试 | `src/runtime/executor.ts` | 不重复成功 Stage，429 按 origin 调度 | `pnpm test -- tests/reliability-runtime.test.ts` |
| P1 | Composable Browser Readiness（首版已完成） | `src/runtime/readiness.ts`、Browser Provider、公开 Read Intent | Intent/Adapter 目标条件优先，Generic 稳定兜底，滚动有预算 | `pnpm test -- tests/browser-readiness.test.ts tests/readiness-tournament.test.ts && pnpm bench:readiness` |
| P1 | Extractor/Validator Registry | `src/reliability/validation.ts`、`src/adapters/` | JSON/Feed/Article 等合同独立可测 | registry contract tests + Benchmark |
| P1 | Artifact Store revalidation/singleflight | Cache/Store adapters | 相同请求合并，304 正确复用，版本升级可重抽取 | cache/revalidation tests |
| P2 | Durable Frontier 与 ResourceGovernor | `src/runtime/frontier.ts`、`resource-governor.ts` | 页级恢复、按 origin 调节、HTTP/Browser 分池 | frontier/recovery/load tests |
| P2 | Shadow 与策略发布闭环 | Benchmark + policy artifacts | 策略有版本、对照、审批和回滚 | shadow redaction + comparison tests |
| P2 | 第一批站点 Adapter | `src/adapters/<site>/` | 每个 Adapter 有 schema、fixtures、canary、退役规则 | adapter contract + release Benchmark |

## Exploration Program

按假设运行实验，不按“功能看起来不错”实施：

1. HTTP/Browse Shadow：测 Browser 的真实 Uplift 和误升级成本。
2. Readiness A/B：固定等待对比正文稳定/目标 selector，观察 Valid Latency 与 False Success。
3. Retry Counterfactual：记录若不重试的结果，估算每类错误的 Recovery/Waste。
4. Extractor Tournament：同 rawRef 运行 Readability、Document、结构化 Extractor，独立 Truth 比较。
5. Concurrency Sweep：在同 Corpus 上逐级提高全局/每 origin 并发，寻找成本和 p95 拐点。
6. Cache Revalidation：比较 full fetch、conditional fetch、stale-while-revalidate 的新鲜度与成本。
7. Adapter ROI：只有当某类页面失败量和付费价值同时足够，才建立专用 Adapter。
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

- 首个 Corpus 的付费场景和类别权重由哪些真实用户任务决定？
- `uncertain` 是否默认返回正文，还是要求调用方显式允许？
- raw response 的保留时间和隐私边界是什么？
- 首批结构化 Adapter 选择 X、文档站、商品列表还是另一垂直？
- 线上 Shadow 的最大采样率和 Browser 成本预算是多少？

## Readiness

本架构规范已经足够按依赖顺序启动 P0：先 Benchmark，再 Contracts/Ledger，再 Planner。它没有声明
任何新模块已经实现，也没有声明 Diaoyan 已达到生产级可靠性、竞品等价或全网最高成功率。
