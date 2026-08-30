# Diaoyan 目标架构完成账本

状态：已完成
范围：批准的本地模块化 Retrieval Runtime
最后更新：2026-08-30

## 使用规则

本文是本轮实现的唯一进度记录。一次只允许一个目标处于 `进行中`。

每个目标都按以下顺序完成：

1. 冻结该目标的输入、输出、错误和安全边界。
2. 先增加一个会因缺少目标行为而失败的测试，并保存 RED 证据。
3. 只实现让该目标通过所需的最小生产改动。
4. 运行聚焦测试和受影响的回归测试。
5. 更新本文的状态、实现证据和验证命令，然后进入下一目标。

禁止为后续目标提前增加抽象、配置、兼容层或占位实现。现有外部合同只有在目标明确要求时才做破坏性修改。

## 总体验收

全部目标只有同时满足以下条件才算完成：

- 所有必做目标均为 `完成`，没有跳过或用文档声明代替运行实现。
- 每次 Provider、Extraction、Validation 和 terminal transition 都有可追溯证据。
- `valid`、`uncertain`、`invalid`、`failed`、`policy_stop` 和 `budget_exhausted` 保持不同语义。
- 授权 Profile、SSRF、robots、RSL、预算和敏感信息边界没有回归。
- Node 25.9.0 下 `pnpm check`、`pnpm build`、`pnpm test` 全部通过。
- 统一 Benchmark 的受控、公开 Canary、Release compare 和环境指纹验收通过；机器 Gate 不再因仓库内可补证据停留在 `experimental`。
- `docs/spec.md`、`docs/roadmap.md`、目标架构文档和真实命令一致。

## 目标清单

| ID | 状态 | 目标 | 完成条件 | 聚焦验证 |
| --- | --- | --- | --- | --- |
| T00 | 完成 | 冻结范围与完成账本 | 本文覆盖当前批准架构、依赖顺序、非目标和统一验收；后续每完成一项即更新 | 文档审查；`git diff --check` |
| T01 | 完成 | 授权 Profile origin 隔离 | `allowedOrigins` 从 Intent 进入执行阶段；授权主导航或重定向越界明确失败；普通第三方子资源不被误拦截 | Planner/Browser 合同测试；授权跨 origin E2E |
| T02 | 完成 | 共享 ReadIntent 边界 | CLI、MCP、Reader 使用同一归一化入口；同输入产生同 Intent、错误和 Plan ID；不增加新配置面 | parser 单元测试；CLI/MCP parity 测试 |
| T03 | 完成 | Validator Registry 与三态终局 | Provider 只产生候选；版本化 Validator 输出 `valid/uncertain/invalid`；uncertain 不再声称 complete；invalid 可按计划升级 | validator 合同测试；HTTP→Browser runtime 测试 |
| T04 | 完成 | Extractor Registry 与同 raw 多抽取 | JSON、JSON-LD、RSS/Atom、Sitemap、PDF、Article/Document 通过确定性 registry 路由；同一 raw response 可尝试多个 Extractor 而不重复下载 | extractor 合同/fixture；fetch-count 集成测试 |
| T05 | 完成 | Raw Store 与版本化 Artifact Store | raw object 内容寻址且不可变；Artifact key 包含 Intent、授权/许可上下文和 Extractor/Validator 版本；授权内容不进入共享存储 | store roundtrip、版本隔离、授权隔离测试 |
| T06 | 完成 | Cache 重验证与复用 | 支持 ETag/Last-Modified/304、同 key singleflight、显式 stale-while-revalidate、容量/TTL 清理；失败不伪装陈旧成功 | cache/HTTP 集成测试；并发 singleflight 测试 |
| T07 | 完成 | 统一 Provider Stage 合同 | Cache、HTTP、Browser、Feed、PDF、Adapter 使用同一显式 registry/StageResult；未知或不可用 Provider 明确失败，不得误路由 | provider contract table；runtime integration |
| T08 | 完成 | Ledger、Frontier 与 publication 一致性 | Attempt、terminal projection 和 Artifact publication 有明确事务/幂等边界；崩溃恢复后不产生分裂真值；删除脱离运行路径的旧 Job 系统 | replay/atomicity 测试；SIGKILL E2E；死代码搜索 |
| T09 | 完成 | Browser 健康与安全 Trace | Browser/Context 健康回收；失败 Trace 有界、抽样、可引用，并清理 Cookie、Authorization、Profile 内容和敏感正文 | crash/recovery、trace redaction、预算测试 |
| T10 | 完成 | 完整 ResourceGovernor | 区分 HTTP、Browser、授权 Session 容量；实现 backpressure、每 origin 延迟反馈、429/503 cooldown、Circuit Breaker 和有界自适应并发；不引入分布式队列 | governor 单元测试；受控负载/E2E |
| T11 | 完成 | 推送式 Crawl 结果 | 在保留稳定 cursor 重放语义的前提下提供有界推送/等待接口；取消、断线和重连不丢 publication | MCP 合同测试；断线重连 E2E |
| T12 | 完成 | 生产 Metrics 与 Trace 投影 | 记录 Planner/Provider/Extractor/Validator 版本、阶段耗时、transition reason、资源、最终真值、cache/revalidation 和 crawl coverage；不记录敏感内容 | aggregation/redaction 测试；CLI/MCP stats parity |
| T13 | 完成 | 统一 Benchmark 与发布比较 | 提供真实存在的 `bench` 入口；完成版本化 Layer A、40-Case 故障配额、重复次数、环境/配置指纹、公开 Canary 过期机制和同 Case Set Release compare | benchmark contract/gate；受控复跑；release compare |
| T14 | 完成 | Optimization Loop | 实现 HTTP/Browser Shadow、Readiness A/B、Retry Counterfactual、Extractor Tournament；策略变更形成版本化、可 review、可回滚工件，不能在线自修改 | shadow redaction；comparison/rollback 测试 |
| T15 | 完成 | Adapter 合同与 ROI Gate | 实现受信任的版本化 Adapter registry、Schema、Fixture、Canary、错误 Case 和退役条件；只有 Benchmark 证明收益后才加入具体站点 Adapter | adapter contract；ROI gate；release Benchmark |
| T16 | 完成 | 文档与实现收敛 | 删除已替代实现和错误命令；`spec` 只描述已实现行为；Roadmap 与本账本同步；公开 README 不夸大成熟度 | 文档命令实跑；`rg` 漂移检查 |
| T17 | 完成 | 最终架构验收 | 全量单元/集成/E2E、真实 Chrome、恢复、并发、Benchmark 和安全回归全部通过，工作树差异经范围审查 | 总体验收中的全部命令 |

## 条件式目标

以下能力只有满足文档既定触发条件才进入实现，不因“未来可能需要”提前建设：

- 具体站点 Adapter：T15 的 ROI Gate 证明通用路径存在足够失败量和持续价值后选择。
- 托管抓取或远程 Browser Provider：只有可复现的同 URL Benchmark 证明单位有效结果更优，且数据边界明确后接入。
- LLM Extractor/Validator：只有确定性路径无法满足已选 workload，且存在明确 token 预算和失败语义时接入。

条件未满足时，“保持未启用并给出证据”就是正确完成状态，不用虚构实现。

## 明确非目标

这些内容在当前 RFC 中被明确延期或不批准，不属于本轮“补全文档功能”：

- 多租户、组织、SSO、RBAC、复杂控制台和账单。
- PostgreSQL、多主机 Worker、Redis、RabbitMQ、Kafka 或 Temporal。
- Go/Rust 重写或拆分微服务。
- 自动绕过 CAPTCHA、登录、付费墙、robots、RSL 或站点访问控制。
- 自动购买许可或调用真实钱包/支付服务。
- 未经用户明确选择，把 Cookie、Profile 或私有内容发送给外部 Provider。

## 完成记录

### T00：冻结范围与完成账本

- RED：不适用；这是后续 TDD 的范围记录，不改变生产行为。
- 实现：新增本文，收敛当前批准架构、依赖顺序、条件式能力和非目标。
- 验证：文档审查与 `git diff --check` 已通过。

### T01：授权 Profile origin 隔离

- 边界：只限制使用授权 Profile 的主框架导航和重定向；匿名 Browser 与页面正常第三方子资源保持现有公网策略。
- RED：`tests/reader.test.ts` 证明授权 origin 没有进入 Browser adapter；`tests/browser-authorization.test.ts` 证明真实 Chrome 会跟随跨 origin 302 并返回正文。
- 实现：`allowedOrigins` 进入 Planned Stage 和 Browser fetch options；授权主导航由 `route.fetch(maxRedirects: 0)` 显式检查每个 redirect，越界返回 `ACCESS_DENIED`，子资源继续使用原公网策略。
- 验证：Node 25.9.0 下 `pnpm check`、`pnpm build` 和全量 `pnpm test` 通过；41 个测试文件、353 个测试通过。Patch Guard `standard` 为 `pass`，无 findings。

### T02：共享 ReadIntent 边界

- 边界：只收敛 CLI、MCP 进入 Reader 后的语义归一化、默认值和错误；不合并 CLI 参数语法与 MCP Zod 传输 Schema。
- RED：`tests/read-intent.test.ts` 因共享模块不存在而失败；CLI/MCP 测试同时证明两条传输入口会在 Reader 前把未指定的 `maxAgeSeconds` 固定为 900，覆盖运行配置。
- 实现：新增单一 `normalizeReadRequest`，统一产生 request 默认值、授权与 readiness 约束、预算、`ReadIntent`、`PlanningFacts` 和 `AccessPlan`；Reader 在公网 URL 校验后只调用该边界。CLI 与 MCP 仅解析并透传显式 read 选项，不再物化 Reader 的语义默认值。
- 验证：Node 25.9.0 下 61 个聚焦测试、`pnpm check`、`pnpm build` 和全量 `pnpm test` 通过；42 个测试文件、354 个测试通过。Patch Guard 对从 `HEAD` 累计的 T01+T02 给出 `review`，唯一 finding 是 8 个生产文件超过 6 文件提示线；人工核对确认 T02 仅涉及 4 个生产文件，未提前实现后续目标。

### T03：Validator Registry 与三态终局

- 边界：只把候选真值从 Extractor/Provider 收敛到纯、版本化 Validator；不加入站点 Validator、LLM、Store 或新的配置面。
- RED：Extractor 测试证明 shell 仍在提取阶段抛错；Registry 合同因实现不存在而失败；Runtime 测试证明 `uncertain` 仍被包装成 `completeness: complete`；补充 RED 证明错误模板没有独立 check、Schema 未满足只得到 uncertain。
- 实现：`ValidatorRegistry` 按候选匹配并以 `invalid > uncertain > valid` 组合版本化结果；generic validator 负责 challenge、登录、付费、shell、错误模板、最小/推荐长度、fallback extraction、canonical 身份和 Schema 证据。Extractor 只返回候选；Executor 仅发布 valid/uncertain，invalid 变为 typed terminal 并通过 Planner 的 `after-invalid` 条件升级；uncertain 明确写为 `completeness: uncertain`。
- 验证：9 个 Validator 合同 Case 与 113 个受影响回归通过；Node 25.9.0 下 `pnpm check`、`pnpm build` 和全量 `pnpm test` 通过，42 个测试文件、359 个测试通过。Patch Guard 对从 `HEAD` 累计的 T01–T03 给出 `review`：10 个生产文件、543 行超过单补丁提示线；人工核对 T03 为 6 个生产文件且没有进入 T04 范围。

### T04：Extractor Registry 与同 raw 多抽取

- 边界：只实现确定性 Extractor 路由、同一内存 raw 的多候选和真实 PDF 字节输入；不持久化 raw/artifact，不改 Cache 或 Provider 合同。
- RED：8 个 Registry 合同测试因 Registry/API 不存在全部失败；Runtime 证明含 JSON-LD 的 HTML 仍只产出 readability，未在同一 fetch 上尝试多个候选；PDF 没有原始字节合同。
- 实现：新增顺序确定的 JSON、JSON-LD、RSS、Atom、Sitemap、PDF.js、Readability、Clean Document 和 Plain Extractor；Registry 保留每次 candidate/not-applicable/failed 结果，同一 `RawPage` 可产生多个候选。Executor 对同 raw 候选执行 T03 Validator，按 valid、uncertain、invalid 选择。HTTP raw 增加有界原始字节；PDF.js 仅命中 PDF 时动态加载并使用包内标准字体。普通 HTML 复用单个 DOM，Document 只在 Article 不足时执行。
- 验证：Registry、真实 PDF、单 fetch 多候选和规模回归通过；Node 25.9.0 下 `pnpm check`、`pnpm build` 和全量 `pnpm test` 通过，43 个测试文件、368 个测试通过。500 页/1000 页恢复验收分别为 15.9 秒/24.5 秒。Patch Guard 对累计 T01–T04 给出 `review`，包含清单变更与累计规模提示；人工核对 T04 新依赖仅 `pdfjs-dist@6.3.289`，没有进入 T05 范围。

### T05：Raw Store 与版本化 Artifact Store

- 边界：只建立本地 immutable raw/artifact CAS 与当前 cache projection；不加入条件请求、singleflight、SWR、清理策略或 Attempt/publication 原子事务。
- RED：4 个 Storage Case 全部因 `storeRaw` 不存在失败，覆盖 raw roundtrip、版本隔离、授权 Profile 和 RSL license token 隔离。
- 实现：旧的单表可变 page JSON cache 替换为 `raw_objects`、`artifacts` 两个只插入 CAS 表和 `artifact_cache_entries` 当前投影。Raw ref 按原始字节 SHA-256；Artifact key 包含规范化 Intent、授权 origin、审批/许可上下文、raw/content hash、Extractor/Validator 版本。Executor 记录真实 rawRef 和版本 evidence，Reader 只把匿名且无 approval/license token 的 artifact 发布到共享 Store/Index。
- 验证：CAS immutable roundtrip、六维 key 隔离、Profile/RSL 不落盘和授权重复读取不命中共享缓存通过；Node 25.9.0 下 `pnpm check`、`pnpm build` 和全量 `pnpm test` 通过，44 个测试文件、373 个测试通过。Patch Guard 对累计 T01–T05 仍为 `review`（依赖清单与累计规模）；人工核对 T05 仅修改 cache/executor/reader/types 四个生产文件，没有进入 T06/T08。

### T06：Cache 重验证与复用

- 边界：只为匿名共享 artifact 增加 HTTP 条件重验证、进程内同计划合并、调用方显式开启的 SWR 和本地 Store 清理；不加入分布式锁、隐式 stale fallback、配置层或 schema 兼容迁移。SWR 结果必须标记 `stale`，后台失败必须由 `drain/close` 抛出。缓存启动时固定保留 30 天、最多 10,000 个投影。
- RED：最初 4 个 Cache Case 分别证明 304 被当空正文、并发 live 读取重复抓取、SWR 仍同步返回新正文、cleanup 不存在；CLI/MCP RED 证明 SWR 无法从公开入口显式选择；持久 Cache 重开 RED 证明 cleanup 未进入运行路径；Validator 更新 RED 证明可变 ETag 错放在 immutable artifact identity。
- 实现：缓存投影保存可变 ETag/Last-Modified 和最近验证时间，304 只更新投影并复用同一 Artifact/rawRef；HTTP 仅向完全相同的重验证 URL发送条件头。`PageCache.singleflight` 按 cache key + plan ID 合并 HTTP 请求，单个订阅者取消不终止仍有订阅者的共享请求。Reader 只在显式 SWR 窗口内返回带 `cacheStatus=stale` 的结果，并合并后台刷新、记录失败、由 `drainBackgroundRevalidations`/`close` 暴露。清理删除过期/超容量投影及失去引用的 Artifact/Raw CAS，持久 Cache 启动时执行固定边界；CLI/MCP 只透传显式 SWR 秒数。
- 验证：Node 25.9.0 下 `pnpm check`、`pnpm build`、40 个聚焦测试和 Reader/Runtime/Site/RSL 共 79 个受影响回归通过。Patch Guard 对从 `HEAD` 累计的 T01–T06 给出 `review`（13 个生产文件、T04 依赖清单及累计行数）；人工核对 T06 的 9 个生产文件均为条件请求到公开入口的必要闭环，没有提前实现 T07。

### T07：统一 Provider Stage 合同

- 边界：Provider 只执行一个 Planned Stage 并返回不可变 `StageResult`，不得验证候选、追加 Ledger 或选择 fallback；Executor 独占重试、抽取、验证、记账和 stage transition。默认 Registry 注册 Cache、HTTP、Browser、Feed、PDF，其中 Feed/PDF 复用受控 HTTP transport 但保留独立 provider identity 与媒体约束；Adapter 在 T15 ROI Gate 前明确登记为 unavailable。未知或 unavailable provider 必须产生 typed failure，不得落入 Browser。不开托管 Provider、插件加载或新配置面。
- RED：`tests/provider-contract.test.ts` 因 Provider Registry 模块不存在而无法加载；合同覆盖全部六种 provider ID、默认 availability 表、Feed runtime identity，以及 unavailable Adapter 绝不误路由 Browser。
- 实现：新增显式 `ProviderRegistry`、capability declaration、统一 immutable `ProviderStageResult` 和内建 Cache/HTTP/Browser/Feed/PDF Provider；Adapter 明确登记为 unavailable。Reader 在 composition root 创建 Registry；Executor 删除 Cache 特判及“非 HTTP 即 Browser”分支，只消费 StageResult 后负责预算、Ledger、Extractor、Validator 与 transition。HTTP shell 的 Provider attempt 现在准确记录为 succeeded，再由 Validator 触发 Browser；预算越界记录 stopped，不再伪装抓取失败。
- 验证：Node 25.9.0 下 Provider/Runtime/Reader/Site/Cache/Store 共 55 个聚焦与受影响测试通过；随后 `pnpm check`、`pnpm build`、全量 `pnpm test` 通过，46 个测试文件、385 个测试通过，含真实 Chrome、MCP stdio、SIGKILL 恢复和 500/1000 页规模验收。Patch Guard 对累计 T01–T07 给出 `review`（15 个生产文件、T04 依赖与累计行数）；人工核对 T07 仅涉及 Provider 合同、types/error、Executor 和 Reader 五个生产文件，没有加入 T08 状态事务。

### T08：Ledger、Frontier 与 publication 一致性

- 边界：保留现有 Frontier 的 lease fencing、terminal page state、publication sequence、discovery 和 budget settlement 单事务；只补 Attempt Ledger 缺失的 request terminal/current projection，以及公开匿名 Artifact 的稳定 requestId 重放。授权或 RSL 受限内容仍不得落入可重放 Artifact。旧 `crawl_jobs` 不做迁移或兼容重写，发现旧 schema 时明确失败；删除未接入应用运行路径的旧 Job Store/Service，不重写已正确的 Frontier。
- RED：`tests/execution-consistency.test.ts` 证明进程重启后同 requestId 会重新抓取、失败终态会被重新执行、Artifact TTL 与 terminal 引用会分离；Attempt Ledger 合同证明没有 terminal commit/project；Frontier 测试证明旧 schema 会被静默改写。上述用例在生产改动前均失败。
- 实现：Attempt Ledger 新增 request terminal 表、成功/失败终态约束、稳定 publication key、幂等 commit 和 requestId/planId 冲突检测；Reader 在 Provider 执行前重放公开匿名 Artifact 或原始 typed error，发布缓存后才提交成功终态。Cache cleanup 同步清理过期 terminal 与其 Artifact/Raw 引用。Executor 透传实际 artifact key。删除未被 composition root 使用的旧 `CrawlJobStore`/`CrawlJobService` 及专属测试；Frontier 遇到旧 `crawl_jobs` schema 时保留原数据并明确报错。Benchmark provenance 同步携带 terminal projection。
- 验证：Node 25.9.0 下 `pnpm check`、`pnpm build`、78 个终态/缓存/Frontier/Reader/Benchmark 受影响测试和 2 个 SIGKILL 恢复 E2E 通过；全量 `pnpm test` 通过，46 个测试文件、382 个测试通过，含真实 Chrome、MCP stdio、500 页并发和 1000 页 SIGKILL 恢复。`rg` 确认生产与测试中没有旧 Job Store/Service 引用，`git diff --check` 通过。Patch Guard 对累计 T01–T08 给出 `review`（18 个生产文件、T04 依赖与累计行数）；人工核对 T08 只闭合 execution terminal/replay、cache retention 和旧 Job 死路径，没有进入 T09。

### T09：Browser 健康与安全 Trace

- 边界：匿名 Browser 固定累计 100 次 Context 后自动回收；断连/崩溃按现有 Stage 重试预算换新 Browser，不新增健康配置或 T10 调度策略。失败时才写本地 JSON Trace：网络与 Console 只保留有界聚合；匿名 DOM 删除脚本、表单值和敏感文本后截断；授权 Profile 不保存 DOM。Trace 文件固定单条大小和保留数量，使用不可猜测引用进入 Attempt Ledger。不开 HAR、截图、录像、OpenTelemetry、远程上传或新配置面。
- RED：BrowserPool 测试证明连接正常的 Browser 永不按生命周期回收；Planner 测试证明 `BROWSER_UNAVAILABLE` 不在 Browser Stage 重试合同；Runtime 测试证明 `traceRef` 从 ReadError 到 Attempt 丢失；`tests/browser-trace.test.ts` 因 Trace Store 不存在无法加载。四类 RED 同次运行共 3 个断言失败和 1 个 suite load failure。
- 实现：匿名池按每 Browser 100 次 Context 启动进入 retiring，等待活动 Context 归零后关闭；Fetcher 将断连/崩溃标为 retryable 且主动把 lease 标为 unhealthy，Planner 只在错误本身 retryable 时按既有预算换新 Browser。新增本地 `BrowserFailureTraceStore`，只在失败时写最多 32 KiB、最多 100 个、0600 权限的不可猜测 JSON 引用；网络仅保留资源类型/状态聚合，Console 仅保留级别计数，DOM 只保留最多 256 个 tag/子节点数/文本长度，授权 Profile 或 CAP Authorization 完全省略 DOM。`traceRef` 通过 ReadError、Provider StageResult、重试包装进入对应 Attempt。
- 验证：Node 25.9.0 下 49 个 Browser Pool/Trace/Planner/Runtime/Provider 聚焦测试通过；真实 Chrome 证明授权失败 Trace 不含 Profile/正文/Cookie/Authorization，匿名失败 Trace 不含正文、属性或 query token且大小有界。随后 `git diff --check`、`pnpm check`、`pnpm build`、全量 `pnpm test` 通过，47 个测试文件、390 个测试通过，含真实 Chrome、MCP stdio、500 页并发和 1000 页 SIGKILL 恢复。涉及 auth/secrets 的路径已人工审查。Patch Guard 对累计 T01–T09 给出 `review`（21 个生产文件、T04 依赖与累计行数）；人工核对 T09 只涉及 Browser lifecycle、失败 Trace 及其必要透传，没有进入 T10 的容量与反馈控制。

### T10：完整 ResourceGovernor

- 边界：保留现有 Crawl 硬预算、Worker 上限、BrowserPool 物理上限、授权 Profile 安全互斥及 Frontier 的持久 origin 间隔；新增一个由 composition root 共享的进程内 Runtime Governor，不增加配置面。HTTP、匿名 Browser、授权 Session 分池，同 Profile 串行；每 origin 上限取现有 Worker 上限与已验收的 16 并发较小值；等待队列可取消且固定有界。429/503 反馈 cooldown，连续 3 次 retryable 故障短路；每池只保留 32 次结果，以加一/减半方式在 1 与现有配置推导的上限间调整。不开系统探针、分布式队列或跨进程协调。
- RED：`tests/runtime-resource-governor.test.ts` 因目标模块不存在无法加载；新增 Provider 主路径合同随后证明把 Governor 传入 Registry 仍会同时启动两个 HTTP fetch。RED 覆盖分池、origin、授权 Session、429/503、Circuit、AIMD、取消和 bounded queue。
- 实现：新增共享 `RuntimeResourceGovernor`，HTTP 上限来自现有 Worker concurrency，匿名 Browser 来自 Pool×Context，授权 Session 来自 Browser 实例且同 Profile 互斥；Provider Registry 在 Fetch 前异步取得 lease，并在 raw 存储或失败后以时延/error 反馈释放。每 origin 在现有配置与 16 并发验收边界内有界；429/503 只暂停该 origin，3 次 retryable origin failure 打开 30 秒 Circuit。每池保留最多 32 个样本，retryable failure 或高 p95 减半，稳定成功加一恢复；三池总等待最多 1024，取消立即移除。同步 Extract/SQLite 写入天然阻塞同一事件循环的新 intake，Provider queue 对上游形成有界 backpressure；Frontier 继续保存重启所需的 origin 时序。
- 验证：9 个 Governor 合同、5 个 Provider 合同及 13 个 Runtime 回归通过；受影响 Reader/Site/Frontier/Crawl budget 共 78 个测试通过。Node 25.9.0 下 `git diff --check`、`pnpm check`、`pnpm build`、全量 `pnpm test` 最终通过，48 个测试文件、400 个测试通过；同 origin 16 并发、500 页规模、1000 页 SIGKILL 和 origin interval 重启验收均通过。一次全量并行运行的 2000ms 墙钟断言为 1938ms，独立 fresh build 重跑及随后全量重跑均通过，未降低断言。Patch Guard v0.2 对累计 T01–T10 报告 `observed`、53 个文件、无二进制且受保护 `AGENTS.md` 无违规；人工核对 T10 只新增运行时容量/反馈闭环，没有进入 T11。

### T11：推送式 Crawl 结果

- 边界：只给现有 `get_crawl_pages` 增加可选 0–30000ms 有界等待；0 保持立即 cursor 读取。等待采用“先读、注册、再读”消除 publication 竞态，只因 cursor 后出现新 publication、任务终局、超时或 MCP 请求取消而结束；全进程最多 256 个 waiter。断线不持久化 waiter，SQLite publication 与 cursor 保持权威，重连后用同 cursor 重放。不开 WebSocket、Webhook、额外通知协议或消息队列。
- RED：`tests/crawl-publication-wait.test.ts` 最初因 `waitForPages` 不存在而 5 个 Case 全部失败；MCP 合同随后证明 `waitMs` 被忽略且等待方法调用次数为 0。Case 覆盖注册后二次读取防丢、终态唤醒、超时、MCP 取消、重连重放和 256 waiter 上限。
- 实现：Frontier Service 新增进程内有界 waiter，先读 SQLite、注册 waiter、再读 SQLite；publication/终态/cancel/close 精确唤醒，超时返回同 cursor 空批次，请求取消明确拒绝。`get_crawl_pages` 新增默认 0、最大 30000ms 的 `waitMs`，仅非零时传入 SDK 的 MCP 请求取消信号；持久真值仍只有 SQLite publication sequence。
- 验证：Node 25.9.0 下 7 个服务/MCP 聚焦测试和真实 stdio E2E 通过；E2E 证明首条 publication 可唤醒等待、SIGKILL 中断未完成请求、同 data directory 重启后从 sequence 1 取得 sequence 2。随后 `git diff --check`、`pnpm check`、`pnpm build`、全量 `pnpm test` 通过，49 个测试文件、406 个测试通过，含真实 Chrome、500 页并发和 1000 页 SIGKILL 恢复。Patch Guard v0.2 对累计 T01–T11 报告 `observed`、无违规；人工核对 T11 只修改 Frontier、MCP 和对应测试，没有引入新传输或队列。

### T12：生产 Metrics 与 Trace 投影

- 边界：扩展现有本地 SQLite 聚合与 `get_crawler_stats`，不建立第二套遥测服务。最终调用按 UTC 日只记录有限非敏感维度：Planner、Extractor、Validator 版本，最终 `completed/completed_uncertain/invalid/failed/policy_stop/budget_exhausted/cancelled`，Cache 的 `live/fresh/revalidated/stale/replayed`，以及已执行 Stage 的 provider/reason code；不保存 URL、origin、requestId、Profile、标题、正文、查询、Header 或 Trace 正文。Provider 版本、Stage 总耗时与 `ResourceUsage` 从 append-only Attempt 投影，不复制事实；耐久 Crawl 只从终态 Job 计数 discovered/published/succeeded/failed/stopped，生产 coverage 定义为 `published/discovered`，不冒充 T13 独立 Truth 的 expected-page coverage。CLI 与 MCP 继续返回同一个 `CrawlerStatsResult`。不开 OpenTelemetry、Prometheus、单请求查询、CPU/RSS 探针、在线策略反馈或新配置面。
- RED：`tests/metrics.test.ts` 的完整投影合同最初只能得到旧 totals/cost，缺少 final states、版本、Stage、资源、transition、Cache 和 Crawl coverage；补充的 Extraction/Validation 阶段耗时断言也先独立失败。测试同时把带 token 的 URL、Profile、标题、正文、错误消息和 trace ref 输入统计层，要求聚合表无敏感值。
- 实现：最终调用写入两个有限维度的 UTC 日聚合表，成功从 Artifact evidence 取得 Planner/Extractor/Validator、Validation truth 和明确 Cache 状态，失败由 Reader 唯一终态分类传入；已执行 Planned Stage 的 provider/reason code 原子累计。Provider 版本、Stage outcome/总耗时和六维 `ResourceUsage` 直接查询 append-only Attempt；Extractor/Validator 处理阶段用单调时钟记录，失败同样进入 typed error evidence。终态 Crawl Job 从 Frontier 规范计数投影 operational coverage。`CrawlerStatsResult` 在 CLI/MCP 共用，任何 invalid Artifact 被当成功统计时明确失败。
- 验证：7 个 Metrics 合同与 70 个 Metrics/Reader/MCP/CLI/Frontier/Ledger 受影响测试通过；真实 stdio + CLI E2E 在同一 SQLite 上返回除生成时刻外完全一致的结构，且输出不含 URL。真实恢复/Chrome E2E 通过。Node 25.9.0 下 `git diff --check`、`pnpm check`、`pnpm build` 通过；最终全量 `pnpm test` 为 49 个文件、408 个测试通过，含 500 页与 1000 页规模。首次并行全量中一个既有 Browser 授权测试撞到 15 秒墙钟，独立原断言 4.1 秒通过，未修改超时，随后全量通过。Patch Guard v0.2 对累计 T01–T12 报告 `observed`、无违规；人工核对 T12 没有保存敏感维度或加入外部遥测。

### T13：统一 Benchmark 与发布比较

- 边界：只收敛现有 Case/Truth/Cost/Gate/Controlled Site 为一个 `pnpm bench -- --mode pr|nightly|release` 入口，不改生产 Planner 或 Validator。所有 Corpus 报告必须携带显式 `caseSetVersion`、内容 Hash、Git SHA、Node/Chrome/OS 指纹、脱敏配置 Hash和每 Case repeat 序号；同一 Case Set 的 repeat 固定按 Case ID、repeat 稳定顺序执行。`pr` 运行仓库内不少于 40 个经生产 Reader 公开合同执行的 Layer A/B Case，每个至少 5 次；`nightly` 在此基础上运行不少于 10 个未过期公开 Canary，每个至少 5 次，过期 Case 在网络调用前成为 `harness_error`。`release --compare` 只接受相同 Case Set version/hash/repeat keys 的报告，输出逐 Case 配对 outcome、有效率/成本变化、延迟 delta 的 median/p95/max 和确定性 95% bootstrap CI；不同 Case Set 明确失败。机器 Gate 从真实报告计算，不用手填计数或降低门槛。私有 30-Case、WCXB/CleanEval 授权副本、生产 rollout 和竞品运行仍依赖外部数据，不伪造为 release/production 证据；不开 T14 Shadow 或在线策略反馈。
- RED：`tests/benchmark-corpus.test.ts` 最初得到 4 个失败，分别证明 Case Set 没有 version、repeat/稳定顺序不存在、过期 Canary 仍触网、Release compare 不存在；统一模式测试随后因 Suite 模块不存在而 load failure。46-Case Reader Matrix 首轮进一步暴露畸形 JSON 真值与无 Content-Type 候选合同两个边界。
- 实现：新增一个 `pnpm bench -- --mode pr|nightly|release` 入口。Case Schema 显式记录文档字节预算；报告携带 Case Set version/hash、Git/Node/Chrome/OS、配置 Hash和 repeat。46 个受控场景覆盖格式、重定向、Retry、状态码、Policy Stop、Browser、超时、溢出和不完整内容，全部只经生产 Reader 公开合同执行；每次运行使用独立数据目录。新增 4 个公开 Case 后，Nightly 固定运行 10 个未过期 Canary。Gate 从报告的 Truth、Provenance、Ledger、预算、Policy 和 scope 投影计算。Release 强制至少 30 次和显式 baseline，只接受完全相同的 version/hash/repeat keys，并输出配对 outcome、有效率/成本 delta 与确定性 latency bootstrap CI。缺失私有 Case 与 rollout 时如实停在 `canary-ready`。
- 验证：PR 真实运行 46 个 Case×5 共 230 次，Truth 通过率 100%，0 false success、0 harness error；Nightly 在显式 Fake-IP 安全开关下运行 56 个 Case×5 共 280 次，Truth 通过率 100%，0 false success、0 harness error，机器 Gate 为 `canary-ready`。HTTPBin UTF-8 Case 首轮发现源文档本身故意包含 U+FFFD，核对正文后把错误真值修正为检测真实 mojibake `ï¿½`，单 Case 连续 5 次与完整 Nightly 均通过。Node 25.9.0 下 `git diff --check`、`pnpm check`、`pnpm build`、全量 `pnpm test` 通过，50 个测试文件、453 个测试通过。Patch Guard v0.2 对累计 T01–T13 报告 `observed`、无违规；没有实现 T14 Shadow 或伪造 release/production 证据。

### T14：Optimization Loop

- 边界：只新增离线/受控 `pnpm bench:optimize` 证据闭环，不增加生产采样配置或在线策略反馈。HTTP/Browser Shadow 仅运行匿名受控 Case，固定有界样本与 Browser 预算，调用方只得到正常主路径结果；工件只保存类别、Truth、Cost 和 Uplift 聚合，不保存 URL、正文、requestId、Header、Cookie、Profile 或 Trace。Readiness A/B 复用现有真实 Chrome 三策略 Tournament。Retry Counterfactual 只读取已有 Benchmark Attempt，离线比较 no-retry/one-retry/current，不增加真实请求。Extractor Tournament 对同一内存 rawRef 运行现有 Registry，以独立断言比较，不重新 Fetch。输出不可变、内容寻址的候选 Policy Artifact；显式 review 后才能形成 release，rollback 只能指向已发布祖先。工件本身不自动修改 Planner，真实策略变化仍需代码 review。不开线上 1%～5% Shadow、远程遥测、自动 rollout、T15 Adapter 或可选模型。
- RED：`tests/optimization-loop.test.ts` 最初因 Optimization Loop 模块不存在而 suite load failure；实现后真实运行进一步暴露 Retry Counterfactual 把“预期失败且 Truth 通过”误算成恢复，以及 Browser Shadow 继承 HTTP Case 总 deadline 导致预算自相矛盾。两处均先由真实报告给出失败证据再修正。
- 实现：新增 `pnpm bench:optimize`。固定运行 3 类匿名受控 HTTP/Browser Shadow×5，输出只含类别级 Truth/Cost/Uplift；复用 5 Case×3 策略×5 次真实 Chrome Readiness Tournament；从 T13 Nightly 的 append-only Attempt 离线计算 no-retry/one-retry/current；对同一 rawRef 强制现有 Article/Document Extractor 都产出候选并由独立断言比较。候选 Policy Artifact 内容寻址且不可变；review/release 每个边界都重新校验工件 ID，未批准不得 release，rollback 只能回到 release ancestry。Runner 只写 candidate，不触碰生产 Planner 或自动审批。
- 验证：真实 `pnpm bench:optimize` 完成 15 组 Shadow，主路径有效 10、Browser 有效 15、Uplift 5、0 false success；Readiness 75 次中 target 为 25/25 valid、0 false success；280-run Nightly Counterfactual 得到 15 次恢复、10 次浪费；同 raw 的 Readability 通过、Document 因导航噪声失败。Node 25.9.0 下 22 个聚焦测试、`git diff --check`、`pnpm check`、`pnpm build`、全量 `pnpm test` 通过，51 个测试文件、457 个测试通过。Patch Guard v0.2 对累计 T01–T14 报告 `observed`、无违规；没有新增生产 Shadow 配置或自动策略修改。

### T15：Adapter 合同与 ROI Gate

- 边界：新增一个可信、进程内、代码显式注册的 Site Adapter 合同与 ROI Gate，不开放动态插件、任意脚本、远程下载或新配置面。Manifest 必须声明稳定 ID/版本、精确 HTTPS host、能力、版本化输出 Schema、Fixture/Live Canary/Error Case ID 和退役条件；Registry 在 Adapter 输出边界只验证一次 Schema，未知 host 或无候选明确返回无匹配，不误路由。注册必须携带内容寻址、与同一 Adapter ID/版本绑定的 ROI 评估；只有通用路径低于预先声明目标、30 天 eligible volume/净节省超过调用方预先声明门槛、Fixture/Canary/Error Case 全通过且存在配对 Release Benchmark 时才 eligible。官方结构化源出现或在完整评估窗口内持续低量/负 ROI 时给出 retire。当前 Nightly 280/280 Truth 通过、没有站点失败候选，且缺私有 Release 证据，因此默认 Registry 必须为空，Adapter Provider 继续明确 unavailable；不虚构首批站点 Adapter，不进入 T16 文档收敛。
- RED：`tests/adapter-contract.test.ts` 最初因 Adapter 合同模块不存在而 suite load failure；运行时桥接测试随后证明合格 Adapter 注册后仍未进入 Extractor 路径；完整性测试再证明保持原证据 Hash 时可篡改 `decision/reasons` 绕过准入。三处均先失败再做最小修复。
- 实现：新增版本化 `SiteAdapterRegistry`、Manifest、输出 Schema、Fixture/Canary/Error Case ID、ROI 评估和退役判断。Registry 只接受与 Adapter ID/版本完全匹配且重新计算后仍 eligible 的内容寻址评估，按精确 HTTPS host 解析并在最终 URL 与输出 Schema 两个可信边界明确失败。`ExtractorRegistry` 在内建确定性 Extractor 前尝试显式注入的合格 Adapter；默认 Adapter Registry 保持为空，T07 的 Adapter Provider 仍为 unavailable，没有具体站点实现或动态加载面。
- 验证：6 个 Adapter 合同、Extractor/Provider/Runtime 共 32 个聚焦测试通过；Node 25.9.0 下 `git diff --check`、`pnpm check`、`pnpm build`、全量 `pnpm test` 通过，52 个测试文件、463 个测试通过，含真实 Chrome、500 页并发和 1000 页 SIGKILL 恢复。Patch Guard v0.2 对累计 T01–T15 报告 `observed`、无违规；现有 Benchmark 没有满足具体站点 Adapter 的 ROI 与配对 Release 条件，因此保持未启用。

### T16：文档与实现收敛

- 边界：只收敛当前有效的公开入口、实现合同、路线图、可靠性架构、Benchmark 规范和已批准技术选型，不改生产代码。历史 `docs/handoffs/` 与 exploration 记录保留其发生时状态；`search-engine-architecture-landscape.md` 描述的是独立的未来搜索引擎目标 C，不并入本轮本地 Retrieval Runtime。删除旧 `mode`、旧 Validator 字段、旧测试路径、错误 `bench --mode` 命令、6-Case/7 类/`experimental` 现状和已完成项的“待实现”描述；条件式外部 Provider、私有 Release 数据、首个具体站点 Adapter 与生产证明继续如实标为未启用或缺外部证据。
- RED：活文档审计发现公开 README/Spec 仍提供已删除的 `mode` 和旧 `validation.status/warnings`；Roadmap 把完整故障配额、Circuit Breaker、推送等待和 Optimization/Adapter Gate 写成未完成；可靠性文档引用不存在的 Schema/测试、错误 `bench --mode`、旧 6-Case/7 类/`experimental` 结论，并把 Stage/Frontier/Trace/Adapter 合同写成与代码不一致。
- 实现：只修改七份活文档，统一 `browserAllowed`、三态 Validator、Provider/Extractor/Store/Ledger/Governor/Trace/Adapter 边界、18 个 MCP 工具、publication wait 和版本化 Metrics；统一 PR/Nightly/Release/Optimization 命令与 `canary-ready` 证据。技术选型 RFC 标明本地 Profile 已批准实现，集群/托管/模型/具体站点 Adapter 仍由门槛触发。保留另一会话新增的搜索引擎目标 C 与历史 handoff，不把它们误算为本轮功能。
- 验证：7 份活文档相对链接全部存在，所有引用测试文件存在，`pnpm cli --help` 与文档一致；`rg` 对旧命令、字段、Case 结论和不存在路径零命中，`git diff --check` 通过。Node 25.9.0 下 `pnpm check` 和文档矩阵实跑触发的全量 `pnpm test` 通过，52 个测试文件、463 个测试通过，含真实 Chrome、500 页并发与 1000 页 SIGKILL 恢复。Patch Guard v0.2 为 `observed`、0 violations。

### T17：最终架构验收

- 边界：不再新增功能或文档范围；只运行 Node 25.9.0 的 check/build/full test、统一 PR/Nightly Benchmark、离线 Optimization Loop、安全/敏感信息静态审计、文档链接/漂移审计和 Patch Guard。Release compare 合同用测试覆盖；没有用户提供的私有同 Case Set baseline 时不伪造 release-candidate。只有全部 fresh 证据通过才关闭本账本。
- 实现：无新增功能；本目标只汇总并重新执行 T00–T16 的统一验收。最终工作树保留另一会话的 `docs/search-engine-architecture-landscape.md` 及其索引内容，不将未来搜索引擎目标 C 计入本轮完成范围。
- 验证：Node 25.9.0 下 `git diff --check`、`pnpm check`、`pnpm build`、全量 `pnpm test` fresh 通过，52 个测试文件、463 个测试通过；包含真实 Chrome、安全授权、500 页并发和 1000 页 SIGKILL 恢复。PR Benchmark 46 Case×5 共 230/230 Truth 通过、0 false success、0 harness error；Nightly 56 Case×5 共 280/280 Truth 通过、0 false success、0 harness error，Gate=`canary-ready`。`pnpm bench:optimize` 完成 15 组 Shadow（Browser uplift 5、0 false success）、75-run Readiness（target 25/25 valid）、280-run Retry Counterfactual（恢复 15、浪费 10）和同 raw Extractor Tournament；只生成未发布的内容寻址 Policy Candidate。
- 安全与范围：8 份最终文档链接通过，活文档旧命令/字段/路径零命中；生产/Harness 无 `eval`、`new Function`、shell command execution 模式，源码/测试无常见硬编码密钥模式，MCP server 无 stdout 日志污染，旧 Job Service/`fetchWithMode`/`shouldRender` 符号零命中。Release compare 的相同 Case Set/repeat keys、置信区间与错误基线拒绝由全量测试覆盖；缺私有 30-Case、配对 baseline 和生产 rollout 时保持不升级。Patch Guard v0.2 最终必须为 `observed` 且 0 violations。
