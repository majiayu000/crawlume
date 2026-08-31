# AI 工具与开发者文档垂直搜索 Phase 3 ADR

状态：Implemented

日期：2026-08-31

关联文档：[一期 ADR](./vertical-search-phase1-adr.md)、
[Phase 3 完成账本](./vertical-search-phase3-ledger.md)、
[搜索引擎架构全景](./search-engine-architecture-landscape.md)

## 1. 目标

Phase 3 先建立检索候选的离线证据闭环，不预先选定 embedding、向量数据库或 reranker。
生产查询继续使用现有 SQLite FTS5 lexical baseline；只有候选在同一固定 query judgment set 上产生
真实结果并通过发布门槛，后续阶段才可以单独决定是否接入生产。

## 2. 决策

`VerticalSearchService.runRetrievalExperiment(name, retrieveCandidate)` 接收一个实验名和一次性的候选
检索回调。回调只需针对 query 返回最多十个真实结果 URL，不注册插件、不改变在线查询编排，也不要求
任何模型或存储依赖。实验名规范化后不可重复，保证每份结果可稳定引用。

每次运行先读取一份 judgment 快照，然后对其中每个 query 同时执行：

1. `SearchService(source=local)`，作为固定 lexical baseline。
2. 当前调用提供的 candidate 回调，作为待比较排序。

候选 URL 在服务边界经过现有 `UrlPolicy` 解析、移除 fragment、去重并截断到十条。baseline 和
candidate 都按同一 expected URL 集计算 Hit@10、Recall@10、MRR@10；报告保存逐 query 的 expected
URL、两边排序、两边指标和配对差值。后续修改 judgment 不会改写已经保存的实验报告。

## 3. 持久化与失败语义

`vertical_search_retrieval_experiments` 以唯一名称保存完整不可变报告。只有全部 query 都成功完成后才
写入；baseline 或 candidate 抛错时错误继续向调用方传播，不产生伪造的成功实验。空 judgment set、
空实验名、重复名称和不存在的实验都显式失败。

`getRetrievalExperiment(name)` 读取原始报告，用于复查具体 query，而不是只保留聚合分数。

## 4. 发布门槛

候选只有同时满足以下条件，`releaseGate.passed` 才为 `true`：

- Hit@10、Recall@10、MRR@10 三项聚合指标都不低于同次实验的 lexical baseline。
- 至少一项聚合指标严格高于 baseline。

报告同时暴露每项 `noRegression` 和 `improvesAtLeastOneMetric`，因此相同结果不会被描述为提升，某项
回退也不会被其他指标的增长掩盖。门槛只表示“具备后续发布资格”，不会自动切换生产 ranker。

## 5. 范围外

- 不实现 embedding、向量索引、reranker、学习排序或模型下载。
- 不建设 ranker 插件注册中心、动态加载器或新的配置面。
- 不修改 `SearchService.searchWeb` 的生产 lexical 行为。
- 不声称当前实现已经取得语义检索收益；测试候选只验证证据与门槛计算。

## 6. 验收

- 实验具有规范化唯一名称，完整结果可以按名称读回。
- baseline 与 candidate 使用同一 judgment 快照并逐 query 配对留痕。
- 发布门槛拒绝无提升候选，只接受无回退且至少一项提升的候选。
- candidate 接口可以接收未来真实 ranker 的 URL 结果，但不引入其依赖。
- 聚焦测试、类型检查、构建、相关回归测试和 Patch Guard 全部产生新鲜证据。
