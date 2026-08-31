# AI 工具与开发者文档垂直搜索二期数据层完成账本

状态：Complete

开始日期：2026-08-31

范围：只实现 [二期数据层 ADR](./vertical-search-phase2-adr.md)。每完成一项立即更新本账本。

| ID | 目标 | 状态 | 验证证据 |
| --- | --- | --- | --- |
| D00 | 冻结长期数据层范围、错误与复用边界 | Complete | ADR 已批准；复用 Raw/Artifact、FTS 与 Durable Frontier；Patch Guard 基线由主会话预先记录 |
| D01 | requested/redirect/final/declared canonical URL 身份观察 | Complete | `tests/page-history.test.ts` 真实 Reader publication 路径保存 redirect edge 与 declared canonical；RED 为 `index.history is not a function`，GREEN 通过 |
| D02 | 可查询页面观察与内容版本历史 | Complete | 同一 Artifact 的未变化重抓保留 2 次观察，变化 Artifact 形成第二内容版本；首次/末次时间和次数断言通过 |
| D03 | 历史引用的 Raw/Artifact 保留 | Complete | Cache `ttl=0/maxArtifacts=0` 清理后，历史引用的 Artifact/Raw 仍可读取 |
| D04 | 带 parser/indexer 证据的离线 FTS 重建 | Complete | 人工破坏 FTS 当前投影后，从历史+Artifact+Raw 恢复；报告 `local-fts-v2` 与 `readability-v1` |
| D05 | 基于变化历史的确定性 recrawl priority 与 durable run 排序 | Complete | unseen > changed > stable；`tests/vertical-search.test.ts` 验证高优先 exact URL 先创建现有 durable job |
| D06 | 文档收敛、完整验证、Patch Guard 与提交 | Complete | `git diff --check`、`pnpm check`、`pnpm build` 通过；最终树受影响测试 16/16；Patch Guard `observed`、16 文件、0 violations；原子提交包含本账本 |

## 明确范围外

- 旧数据回填、兼容读取或 schema 迁移框架。
- WARC、对象存储、PostgreSQL、远程 worker 或分布式索引。
- canonical 自动折叠、近似重复、链接图、embedding 或 reranker。

## 最终验证记录

- RED：Phase 2 聚焦测试最初 5 个失败，分别为 `history`、`recrawlPriorities`、历史保留和 durable
  排序行为缺失；随后最小实现 GREEN。
- 聚焦回归：page history、vertical search、index、reader、storage、validation 共 54 个测试通过。
- Node.js 25.9.0：`git diff --check`、`pnpm check`、`pnpm build` 通过。
- 全量：最终冲突语义落地前，`pnpm vitest run --maxWorkers=1` 为 54 个文件、480 个测试通过；最终
  树随后运行 481 个测试，其中 479 个通过，2 个既有墙钟 E2E 在整机争用下失败；同一最终树原样
  隔离重跑 recovery/scale 共 4/4 通过，相关 page-history/vertical-search 16/16 通过。覆盖真实 Chrome、
  500 页并发和 1,000 页 SIGKILL 恢复，未修改测试门槛。
- Patch Guard：`observed`，16 个任务相关文件，0 violations；无删除、无二进制文件。
