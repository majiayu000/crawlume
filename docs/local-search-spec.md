# Crawlume v0.4 本地全文索引规范

## 目标

在管理员显式设置 `CRAWLUME_LOCAL_INDEX_ENABLED=1` 时，把已经由 Crawlume 合规读取的公开页面
沉淀为本地可搜索语料，减少重复依赖外部搜索服务。该功能默认关闭，不属于爬虫核心执行链路。
本阶段不建设全网索引，不引入分布式队列，也不索引使用授权 Profile 读取的内容。

## 数据流

1. `read_page` 或 `crawl_site` 成功取得完整页面。
2. 未使用 `authProfile` 的页面按最终 URL 写入 SQLite，并用 FTS5 建立标题、URL 和正文索引。
3. 同一最终 URL 再次读取时更新正文、哈希和抓取时间，不产生重复文档。
4. `search_web` 根据 `source` 选择本地索引、SearXNG 或两者组合。

当前投影最多保存 300,000 个不同 final URL；达到容量后新 URL 以 `BUDGET_EXHAUSTED` 失败，已有
URL 仍可更新。`indexed_page_versions` 按 final URL + content hash 记录首次抓取时间和
extractor/validator 版本；同一 hash 的重抓不新增版本。原始正文仍由 Raw CAS/Artifact 表拥有。

长期数据层按每次公开 publication 保存 Artifact/Raw 引用和 URL 身份观察，包括 requested URL、
有序 redirect edge、final URL 与页面声明的 canonical URL；canonical 只作为可审计声明，不自动折叠
URL。未变化重抓仍保留观察，内容版本按 Artifact 聚合。当前 FTS 投影可在不联网的情况下从仍存在的
Raw/Artifact 离线重建，并报告 parser/extractor 与固定 indexer 版本；任一依赖缺失都会显式失败并
保留原投影。已准入 exact URL 的每日 durable run 顺序由确定性的内容变化率和陈旧时间决定，容量与
预算边界不变。详细合同和完成证据见 [二期数据层 ADR](./vertical-search-phase2-adr.md) 与
[二期数据层账本](./vertical-search-phase2-ledger.md)。

当前投影可以创建内容寻址的不可变 release manifest；manifest 只保存 Raw/Artifact/history 引用、
完整投影 hash 和处理版本，不复制正文。创建不自动激活；激活和回滚只接受依赖完整且可重建的
complete release，投影切换与 active 指针位于同一事务。普通索引写入会使 active 指针失效。
详细合同见 [Phase 5 发布 ADR](./vertical-search-phase5-release-adr.md)。

AI 工具与开发者文档一期通过 `CrawlumeApp.verticalSearch` 管理官方 domain、人工 URL、SearXNG
候选、每日 durable crawl run 和固定 query judgment。其分层准入、600/300,000/60,000 容量及
评测合同见 [一期 ADR](./vertical-search-phase1-adr.md)。该管理入口仅在本地索引启用时存在；
SearXNG 只用于候选发现，自主质量评测强制 `source=local`。

缓存命中也会补写索引，以便现有缓存数据在再次读取后自然迁移。本地索引与页面缓存共享同一
SQLite 文件，但使用独立表。

## 搜索接口

`SearchWebOptions` 新增：

- `source`: `auto`、`local` 或 `web`，默认 `auto`。

语义：

- `local`：只搜索本地 FTS5，支持 `limit` 和 `page`。
- `web`：只调用已配置的外部 Provider；未配置时返回
  `SEARCH_PROVIDER_NOT_CONFIGURED`。
- `auto`：第 1 页先搜索本地，再调用外部 Provider 补足 `limit`，并按规范化 URL 去重；
  后续页直接使用外部 Provider，避免两套分页产生重复和错位。
- `auto` 下外部 Provider 未配置时，如果本地库已有文档，则返回本地结果；如果本地库为空，
  返回 `SEARCH_PROVIDER_NOT_CONFIGURED`。
- `auto` 下已有本地命中而外部补足失败时，返回 `status: partial` 和结构化 warning；本地没有
  命中时继续原样抛出 Provider 错误。

`SearchResult` 新增 `source: local | web`。本地结果的 `engines` 为
`["crawlume-local"]`，`score` 为 `null`，避免把 FTS 排名与外部 Provider 分数错误比较。

`SearchWebResult`：

- `status`: `ok | partial`。
- `provider`: `local`、外部 Provider 名称或 `local+<provider>`。
- `warnings`: 外部补足失败时包含稳定 code、message 和 retryable；其他成功结果为空数组。
- 混合结果的 `totalResults` 为 `null`，因为两套结果去重后无法可靠推导全量数量。

`SearchService.searchWeb` 的公共返回还包含执行证据：correlation ID、请求 source、实际执行的
`local|web` 来源，以及仅在本地检索确实执行时存在的查询前文档数和 `local-fts5-v1` 快照。
`get_search_status` 是只读 MCP 工具；没有本地索引和 Web Provider 时返回 `unavailable`，否则返回
`ready`。Provider 名称只表示已经配置，不表示实时健康探测成功。

每个通过参数校验的查询把 `ok|partial|failed`、请求/实际 source、耗时、结果/警告数和失败码写入
最多 90 天的脱敏 SQLite 样本。只读 `get_search_stats` 返回观测完整率、可用率、p50/p95/max 和
失败原因，不把观测值冒充预设 SLO 门槛；样本不保存 query、URL、正文、Provider 地址或 correlation ID。

`VerticalSearchService.runRetrievalExperiment` 使用同一 judgment 快照保存 lexical baseline 与候选
结果的逐 query 配对指标。只有 Hit@10、Recall@10、MRR@10 均不回退且至少一项提升时发布门槛才
通过；该门槛不自动改变生产查询，也不代表已经实现 embedding 或 reranker。

## 安全与失败边界

- SQL 查询继续使用参数绑定。
- 用户查询转换为字面量 FTS token，不允许直接注入 FTS5 操作符。
- 只索引已经通过 URL、robots、访问状态和内容完整性检查的成功页面。
- `authProfile !== null` 的页面绝不写入全文索引。
- 外部搜索失败不得静默伪装为完整成功。
- 本地索引初始化失败必须阻止应用启动，不得降级为无索引运行。

## 影响文件

- `src/index.ts`：SQLite FTS5 存储和查询。
- `src/page-history.ts`：URL 身份观察、内容版本、离线重建和 recrawl priority。
- `src/index-release.ts`：内容可验证的本地索引 release、显式激活和回滚。
- `src/search-metrics.ts`：隐私安全的查询结果与时延证据。
- `src/sqlite-backup.ts`：可验证 SQLite online backup 与只恢复到新路径的演练边界。
- `src/reader.ts`、`src/app.ts`：成功读取后的索引写入和生命周期。
- `src/search-serving.ts`、`src/search.ts`、`src/types.ts`：查询编排、垂直控制和返回契约。
- `src/mcp.ts`、`src/cli/main.ts`：暴露 `source` 参数。
- `tests/`：索引更新、授权隔离、本地搜索、混合去重和显式部分失败。
- `README.md`、`docs/spec.md`、`docs/roadmap.md`：使用说明和版本状态。

## 验收

- 读取公开页面后可在无 SearXNG 环境下用 `source=local` 找到。
- 重读同一最终 URL 后只保留最新版本。
- 当前投影满 300,000 页时拒绝新 URL，但允许已有 URL 更新；内容版本审计按 hash 去重。
- URL 身份观察可查询，历史 Raw/Artifact 不被缓存清理误删，FTS 可离线重建。
- 内容变化率与陈旧时间确定性排序已准入 exact URL，仍复用 Durable Frontier。
- release 创建、激活和回滚保持 manifest/依赖/投影/active 原子一致，篡改与缺失依赖显式失败。
- WAL 一致备份可校验并恢复到不存在的新路径，损坏备份和既有目标被拒绝。
- 查询统计跨重启保留脱敏观测值，并报告真实分位数与失败原因。
- 授权 Profile 页面不会出现在本地搜索。
- 混合搜索本地优先、URL 去重并补足结果。
- 外部 Provider 补足失败时返回 `partial`，无本地结果时仍失败。
- 类型检查、构建和全部单元测试通过。
