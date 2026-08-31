# AI 工具与开发者文档垂直搜索 Phase 3 完成账本

状态：Complete

开始日期：2026-08-31

本账本只记录 [Phase 3 ADR](./vertical-search-phase3-adr.md) 的最小离线检索实验闭环。

| ID | 目标 | 状态 | 验证证据 |
| --- | --- | --- | --- |
| Q00 | 固定 Phase 3 范围与 lexical 生产边界 | Complete | ADR 明确离线实验不修改生产查询，不预装向量或模型依赖 |
| Q01 | 可命名、不可覆盖的 retrieval experiment | Complete | 聚焦测试验证名称规范化、按名称读回及重复名称显式失败 |
| Q02 | 同一 judgment 快照下逐 query 配对留痕 | Complete | 报告持久保存 expected、baseline、candidate 排序与逐项差值 |
| Q03 | candidate-vs-baseline 发布门槛 | Complete | 聚焦测试验证真实提升通过、完全相同结果不通过 |
| Q04 | 完整验证、Patch Guard 与提交 | Complete | `git diff --check`、25 个聚焦回归、`pnpm check`、`pnpm build` 通过；全量 474/477 后，3 个未修改的时间敏感 E2E 串行重跑 10/10 通过；Patch Guard 见最终证据 |

## 不代表的结论

- 测试中的 candidate 是确定性数据，只证明比较合同正确，不证明 embedding 或 reranker 有收益。
- `releaseGate.passed` 不自动修改生产 ranker；生产查询仍为 SQLite FTS5 lexical baseline。
- 具体候选技术必须以后用真实 corpus、真实结果和本合同单独验证。

## 最终证据

- RED：`tests/vertical-search.test.ts` 的两个实验测试因
  `service.runRetrievalExperiment is not a function` 失败，证明测试命中缺失行为。
- GREEN：垂直搜索聚焦测试 12/12 通过；本地索引、搜索和垂直实验相关回归 25/25 通过。
- 静态验证：Node.js 25.9.0 下 `pnpm check`、`pnpm build` 与 `git diff --check` 通过。
- 全量回归首次运行 53 个文件中 50 个通过、477 个测试中 474 个通过。三个失败都位于未修改的抓取
  E2E 时间窗口；保持原断言不变后逐文件串行重跑，三个文件 10/10 测试通过。
- Patch Guard：`observed` 5 个任务文件、0 个 constraint violation；未修改受保护的 README/roadmap。
