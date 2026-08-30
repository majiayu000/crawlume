# 耐久、并发、可恢复 Crawl 实施计划

状态：已完成（2026-08-30）

日期：2026-08-30

## 1. 目标

把当前“持久 Job 包裹内存串行 BFS”的异步抓取改造成真正的页级耐久 Crawl Runtime。

完成后，系统必须能够：

- 把待抓、执行中、成功、失败页面持久化到 SQLite Frontier。
- 在单个服务进程内并发执行多个页面，同时保持按 origin 的启动间隔和资源上限。
- 在进程被 `SIGKILL` 后从页级 checkpoint 恢复，不重新抓取已经终态提交的页面。
- 暂停、恢复和取消 Crawl；暂停不得领取新页面，取消必须中断活动页面并形成明确终态。
- 对整个 Crawl 累计 Provider attempt、主文档字节、Browser 时间和 Browser Context，硬预算耗尽后停止领取新页面。
- 用分页结果接口持续读取已完成页面，保证 publication sequence 单调且同一 URL 不重复交付。
- 保持 Reader、Planner、Stage Executor、URL Policy、robots、RSL 和 Attempt Ledger 为唯一页面执行路径。

本计划不通过降低现有 SSRF、robots、授权或 Benchmark Gate 来换取功能。

## 2. 当前基线与结构债务

当前实现的事实：

- `SiteService.crawlSite` 使用进程内 `Array + Set`，每页 `await`，没有页级 checkpoint。
- `CrawlJobStore` 只持久化整项 Job 的 input/result JSON。
- 重启恢复会把整个 `running` Job 重新置为 `queued`，已经完成的页面会重新抓取。
- `CrawlRequestPolicy` 的 origin 时间状态在内存中，重启后丢失。
- 调用方的 `ExecutionBudget` 当前是每页预算，不是整个 Crawl 的累计预算。
- `get_crawl` 只能一次返回整份结果，不适合数百或数千页面。
- 现有恢复测试使用 fake executor，并没有启动真实服务进程、真实 HTTP 和真实 SQLite。

因此，本阶段不继续扩张 `SiteService` 的内存 BFS，也不把更多状态塞进 `crawl_jobs.result_json`。

## 3. 产品边界

### 3.1 保留

- `crawl_site` 保持小规模同步抓取，用于短任务和调试。
- `start_crawl`、`get_crawl`、`cancel_crawl` 继续作为耐久任务主入口。
- Reader 继续负责单页访问，Frontier Worker 不直接调用 HTTP 或 Browser Fetcher。
- 执行采用 at-least-once，终态提交和结果发布采用幂等事务。

### 3.2 新增

- `pause_crawl`
- `resume_crawl`
- `get_crawl_pages(jobId, afterSequence, limit)`
- `get_crawl` 中的页级 progress、累计 usage、预算和 truncated 信息
- `start_crawl` 的 `concurrency`、`crawlBudget` 和最高 10,000 页异步上限

### 3.3 不在本阶段做

- Redis、Kafka、RabbitMQ 或多机分布式调度。
- 身份轮换或绕过访问控制。
- 通用点击脚本和任意 JavaScript 插件。
- Exactly-once 网络访问。进程在响应完成但 SQLite 提交前被杀时，允许页面网络请求重放；对外交付不得重复。
- Sitemap、Feed、PDF 和 Extractor Registry。这些在耐久 Crawl 稳定后进入下一阶段。

## 4. 核心合同

### 4.1 Job 状态机

```text
queued -> running -> completed
          |   |  -> failed
          |   |  -> cancelled
          |   -> paused -> running
          -> cancelled
paused ---------------> cancelled
```

Job 只保存任务生命周期和 Frontier projection，不再是页面事实源。

### 4.2 页面状态机

```text
queued -> leased -> succeeded
                 -> failed
                 -> stopped
leased -> queued
```

`leased -> queued` 只允许以下情况：

- lease 到期。
- 拥有相同 owner 和 generation 的 Worker 在 graceful shutdown 时释放。
- retry policy 明确允许再次执行。

终态提交必须带 `leaseOwner + leaseGeneration` fencing。迟到 Worker 的提交影响 0 行时必须丢弃，不得覆盖新 Worker 的结果。

### 4.3 Crawl 累计预算

新增独立 `CrawlBudget`，避免改变现有每页 `ExecutionBudget` 的含义：

```ts
type CrawlBudget = {
  maxDurationMs: number;
  maxProviderAttempts: number;
  maxDocumentBytes: number;
  maxBrowserMs: number;
  maxBrowserContexts: number;
};
```

规则：

- Job 创建时持久化绝对 deadline。
- Worker 领取页面前在同一 SQLite 事务中预留资源 slice。
- 页面完成后按 Attempt Ledger 实际 usage 结算并退回未使用预留。
- 并发页面的预留总和不得超过剩余预算。
- 预算耗尽时，未执行页面转为 `stopped/BUDGET_EXHAUSTED`，Job 以 `failed/BUDGET_EXHAUSTED` 结束，不伪装成部分成功。
- 存储错误、状态损坏和根页面失败仍使 Job 进入 `failed`。

### 4.4 结果发布

每个页面终态事务同时写入不可变 `publicationSequence`。分页接口按该序列读取：

```ts
type CrawlPageBatch = {
  jobId: string;
  pages: CrawlPagePublication[];
  nextSequence: number;
  done: boolean;
};
```

客户端可重复使用同一 cursor；同一页面只有一个 publication sequence。

## 5. SQLite 设计

### 5.1 `crawl_jobs`

新增或迁移字段：

- `schema_version`
- `status`，加入 `paused`
- `worker_owner`
- `deadline_at_ms`
- `concurrency`
- `budget_json`
- `usage_json`
- `reserved_usage_json`
- `discovered_count`
- `queued_count`
- `leased_count`
- `succeeded_count`
- `failed_count`
- `stopped_count`
- `published_count`
- `next_publication_sequence`
- `pause_requested`
- `cancel_requested`
- `truncated`

### 5.2 `crawl_frontier`

字段：

- `id`，稳定 UUID，同时作为该页面 Reader requestId。
- `crawl_id`
- `requested_url`
- `normalized_url`
- `origin`
- `depth`
- `discovered_from`
- `discovery_sequence`
- `state`
- `next_eligible_at_ms`
- `lease_owner`
- `lease_expires_at_ms`
- `lease_generation`
- `execution_count`
- `reserved_usage_json`
- `result_json`
- `error_json`
- `publication_sequence`
- 创建、开始、完成时间。

约束和索引：

- `UNIQUE(crawl_id, normalized_url)`
- `(crawl_id, state, next_eligible_at_ms, discovery_sequence)`
- `(crawl_id, publication_sequence)`
- `(state, lease_expires_at_ms)`

### 5.3 `crawl_origin_state`

- `crawl_id`
- `origin`
- `next_allowed_at_ms`
- `backoff_until_ms`
- `version`

页面领取事务原子预留下一个 origin 启动时刻。origin 使用 `scheme + host + port`，不能只用 hostname。

### 5.4 迁移

- 使用显式 schema migration，不依赖 `CREATE TABLE IF NOT EXISTS` 自动增加列。
- 新 Job 只使用新 Frontier。
- 当前处于 `queued/running` 的旧 Job 在迁移时明确失败为 `UNSUPPORTED` 或转为新根页面；不得静默丢状态。
- Frontier、Job projection、publication 使用同一个 SQLite 连接，保证事务原子性。

## 6. Runtime 设计

### 6.1 文件边界

- `src/runtime/frontier.ts`：内部状态、lease token、状态机 invariant。
- `src/frontier-store.ts`：SQLite migration、claim、heartbeat、fenced commit、projection 和分页。
- `src/runtime/resource-governor.ts`：Crawl 总预算 reservation/settlement。
- `src/runtime/frontier.ts`：并发 Worker、wake timer、heartbeat、pause/cancel/shutdown 与公开 projection。
- `src/site-scope.ts`：URL normalize、scope 和 link enqueue 规则，供同步 Site 与耐久 Worker 共用。
- `src/jobs.ts`：保留 Attempt Ledger 和薄 Job facade，不再承载页面执行循环。
- `src/app.ts`：composition 和生命周期。
- `src/mcp.ts`：公开输入、progress、分页、暂停和恢复工具。

### 6.2 并发模型

- 单个 Job 的默认并发为 4，公开范围 1–32。
- Worker 只通过 Frontier claim 获得页面，不共享内存 queue。
- 每个活动页面有独立 AbortController 和 heartbeat。
- claim 事务同时处理 URL cap、origin next-start、预算 reservation 和 lease generation。
- 没有立即可领取页面时，根据最早 `nextEligibleAt`、origin slot 或 lease expiry 设置单个 wake timer，不固定轮询。
- Browser profile 页面在调度层串行等待，不把正常容量竞争转换成 `BROWSER_UNAVAILABLE`。

### 6.3 恢复与关闭

- 启动时只回收过期 page lease，不无条件重置所有 running Job。
- `SIGKILL` 后，新进程等待或回收过期 lease，已成功页面保持终态。
- graceful shutdown 停止 claim，abort 活动页面，释放属于本 owner/generation 的 lease，然后关闭 Provider 和 SQLite。
- SQLite busy 可按短退避重试；disk full、corruption 和 migration failure 必须使 Worker fail-visible。

## 7. 实施顺序与 TDD Gate

### Phase A：公开合同与真实 RED Harness

1. 新增真实 controlled durable graph server。
2. 新增真实 MCP stdio 子进程 harness，启动 `dist/server.js`。
3. 先写并观察以下 RED：
   - 真实进程中并发峰值大于 1。
   - `SIGKILL` 后同 data dir 恢复，已发布页面不重复。
   - pause 后请求数停止增长，resume 后完成。
   - cancel 中断活动 socket，Job 终态为 cancelled。
   - 累计字节或 attempt 预算耗尽后不再发新请求。
   - 1000 页通过 cursor 完整读取，URL 和 publication sequence 唯一。

Gate：测试必须因为工具/表/行为缺失而失败，不能因为语法或 harness 错误失败。

### Phase B：Frontier Store

1. 实现 migration 和根页面入队。
2. 实现原子 dedupe、maxPages cap 和 discovery sequence。
3. 实现 lease claim、heartbeat、expiry recovery 和 fencing。
4. 实现终态提交、publication sequence、progress projection 和分页读取。

Gate：使用真实临时 SQLite 文件，不使用 `:memory:` 或 fake store；并发 claim 不重复，迟到提交被 fencing 拒绝。

### Phase C：Resource Governor 与 origin 调度

1. 实现累计预算 reservation/settlement。
2. 页面执行预算按剩余总预算缩小。
3. 实现持久 origin start interval 和 `Retry-After` cooldown。
4. 实现 deadline 到期和未执行页面 stopped 投影。

Gate：真实 HTTP 服务记录的请求、字节、时间和 SQLite usage 一致；并发执行不能突破预算。

### Phase D：并发 Crawl Worker

1. 用 Frontier Worker 替换异步 Job 调用 `SiteService.crawlSite` 的路径。
2. 实现 N 个活动页面、heartbeat、wake timer 和 backpressure。
3. 实现 pause/resume/cancel/graceful shutdown。
4. 保持同步 `crawl_site` 独立且有界。

Gate：真实 500 页抓取并发完成；峰值并发符合配置；同 origin 启动间隔符合配置。

### Phase E：公开接口与大结果

1. 扩展 MCP schema，暴露 concurrency、每页预算和 Crawl 总预算。
2. `get_crawl` 返回 progress/usage，不返回无限增长的完整结果。
3. 新增 `get_crawl_pages`、`pause_crawl`、`resume_crawl`。
4. 异步 `start_crawl` 的 `maxPages` 上限提升到 10,000；同步 `crawl_site` 保持 50。
5. 更新 README、Spec、Roadmap。

Gate：真实 MCP Client 只通过 stdio 工具完成启动、观察、分页、暂停、恢复、取消。

### Phase F：生产级 E2E 验收

所有验收都使用构建后的 `dist`、独立 Node 子进程、真实 SQLite 文件和真实 socket，不使用 `vi.fn`、
InMemoryTransport、自定义 PageFetcher 或 `:memory:` 数据库作为完成证据。

必须通过：

1. 500 页并发 Crawl，全部页面唯一发布。
2. 1000 页 Crawl，中途 `SIGKILL`，同 data dir 重启后完成；终态页面不重抓。
3. Diamond/cycle/query/hash 图去重正确。
4. 两个 origin 的并发与各自 start interval 正确。
5. 真实 429 `Retry-After` 阻止同 origin 新页面提前启动。
6. 慢响应页面在 cancel 时 socket 被关闭，lease 被释放。
7. Crawl 总 attempt、bytes、Browser 时间或 deadline 分别耗尽时显式终止。
8. 真实 Chrome JS 图至少一次并发/池复用/恢复验收。
9. SQLite `PRAGMA integrity_check = ok`，关闭后无 `leased/running` 脏状态。
10. 全量测试、TypeScript check、build、`git diff --check` 和既有公网 Corpus 不回归。

## 8. 量化验收标准

- 500 页受控图完成率 100%，publication 重复数 0。
- 1000 页 kill/restart 后 publication 完成率 100%，已提交页面额外请求数 0。
- 配置 concurrency=4 时，受控多 origin 图峰值在 2–4，不能退化为 1。
- 每 origin 首次请求启动间隔不得小于配置值减去 50ms 计时误差。
- 预算实际消费不得超过限制；允许未使用 reservation 被退回。
- pause 后一个已在途页面允许完成，此后不得增加新 page request。
- cancel 后所有活动请求在 2 秒内结束，Job 不得 completed。
- cursor 分页读取 1000 页时 sequence 严格递增、URL 唯一、done 最终为 true。
- kill/restart、cancel、429、预算耗尽均不得产生 False Success。

## 9. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 并发预算 oversubscription | claim 事务先 reserve，完成后 settlement/refund |
| 旧 Worker 迟到提交 | owner + generation fencing，0-row commit 丢弃 |
| SQLite 同步 API 阻塞事件循环 | 事务保持短小、prepared statement、500/1000 页实测 p95 |
| 多连接 schema/事务不一致 | Frontier/Job/publication 共用单一 Store 连接 |
| Browser Profile 并发误报失败 | 调度层 profile permit，不让 Provider 容量竞争变成内容失败 |
| 大结果突破 MCP buffer | `get_crawl` 只给摘要，页面用 cursor 分页 |
| 测试绕开 SSRF | 使用公开外观 URL + 本机 forward proxy，不增加生产 loopback 后门 |
| Benchmark 继续挤占功能开发 | 当前故障矩阵保持回归护栏，完成本计划前不追求 40×5 配额 |

## 10. 完成定义

只有 Phase A–F 全部通过，才可称为“耐久并发 Crawl 首版完成”。

类型检查、单元测试或同进程 fake executor 通过都不能单独构成完成证据。最终报告必须列出真实进程
命令、页面规模、并发峰值、kill/restart 请求差异、预算消费、SQLite integrity 和全部失败场景。

## 11. 完成证据

实现采用 TypeScript/Node 控制面与执行面、SQLite WAL 页级 Frontier、Undici HTTP Provider 和
Playwright Chrome Provider；没有引入 Redis 或多机队列。与初稿唯一的文件边界调整是 Worker 保持在
`src/runtime/frontier.ts`，避免为了文件名拆出共享状态后产生循环依赖。

真实验收命令：

```bash
fnm exec --using 25.9.0 npm test -- --run --no-file-parallelism
fnm exec --using 25.9.0 npm run check
fnm exec --using 25.9.0 npm run build
DIAOYAN_ALLOW_DNS_FAKE_IP=1 fnm exec --using 25.9.0 npm run bench:corpus
DIAOYAN_ALLOW_DNS_FAKE_IP=1 fnm exec --using 25.9.0 npm run bench:readiness
git diff --check
```

已取得的真实证据：

- 500 页：500/500 成功，峰值并发 16，URL、执行和 publication 均无重复。
- 1000 页：至少 9 页提交后 `SIGKILL`，同一 SQLite 重启后 1000/1000 成功，已提交 URL 请求数不增加。
- MCP/HTTP/SQLite：构建后的 stdio 子进程经真实 forward proxy 抓取；`PRAGMA integrity_check = ok`。
- Chrome：真实 Chrome 进程并发 2 个动态页面；Context 预算耗尽后未领取页面明确停止。
- 控制：pause 不再 claim、resume 恢复、cancel 在 2 秒内关闭活动 socket，终态无 queued/leased。
- 调度：两个 origin 可并发，各 origin 内间隔独立；跨 `SIGKILL` 仍满足 2 秒间隔；真实 429 的
  `Retry-After: 2` 阻止后续同 origin 提前启动。
- 累计预算：真实 Provider attempts、精确主文档 bytes、总 deadline 和 Chrome Context 分别验证
  `BUDGET_EXHAUSTED`，queued 页面均产生 `stopped` publication。
- 去重：深度 2 的根回链、共享根节点、fragment 和 query 变体未产生额外请求。
- 全仓：40 个测试文件、347 个测试全部通过；TypeScript check、build 和 diff check 通过。
- 公网 Corpus：6/6 truth passed、0 false success、0 harness error；本机 Clash Fake-IP 环境按 README
  显式开启 hostname Fake-IP 解析许可，字面私网/Fake-IP URL 仍由 SSRF policy 拒绝。
- Readiness Tournament：目标条件策略 25/25 有效、0 false success，真实 Chrome 版本
  `152.0.7977.64`。

Vitest 的重型 E2E 文件必须串行执行，避免多套 MCP/代理/Chrome 同时争抢一台开发机；单个 Crawl
场景内部仍按生产配置并发（500/1000 页均为 16）。这不改变断言或产品并发上限。
