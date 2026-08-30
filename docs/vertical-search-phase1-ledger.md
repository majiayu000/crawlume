# AI 工具与开发者文档垂直搜索一期完成账本

状态：Complete

开始日期：2026-08-31

容量：600 个官方域名 / 300,000 个索引页面 / 每日 60,000 次 Provider 尝试

本账本只记录 [一期 ADR](./vertical-search-phase1-adr.md) 的实现；每完成一项立即更新状态和验证证据。

| ID | 目标 | 状态 | 验证证据 |
| --- | --- | --- | --- |
| V00 | 确认分层准入、容量与最小架构 | Complete | ADR 已批准；Patch Guard 基线位于 `.git/patch-tournament/vertical-search-phase1-20260831.json` |
| V01 | 官方域名、人工 URL、候选池与准入持久化 | Complete | `tests/vertical-search.test.ts`：2 个 RED→GREEN 测试通过，含 600 域名边界 |
| V02 | SearXNG 候选发现与白名单内自动准入 | Complete | `tests/vertical-search.test.ts`：4 个测试通过；白名单外 pending、显式拒绝、Provider 失败可见 |
| V03 | 60,000 尝试与 300,000 页面硬限制下的每日计划 | Complete | 600 域名生成 600×100 计划；索引仅余 50 页时计划严格降至 50；满容量显式失败 |
| V04 | Durable crawl job 启动、恢复汇总与显式失败状态 | Complete | durable job ID 持久化；聚合完成/失败得到 `partial`；`tests/vertical-search.test.ts` 7 个测试通过 |
| V05 | FTS 当前投影容量与内容版本审计 | Complete | `tests/index.test.ts`：300,000 默认容量、满容量拒绝新页、原 URL 可更新、内容 hash 去重版本审计；5 个测试通过 |
| V06 | 固定 query judgment 与 Hit@10/Recall@10/MRR@10 评测 | Complete | judgment 持久化并强制 local-only 评测；空集合拒绝报告；聚焦测试验证 Hit@10=1、Recall@10=0.75、MRR@10=0.75 |
| V07 | App 接入、文档收敛与完整验证 | Complete | `DiaoyanApp.verticalSearch` 生命周期通过；56 个活文档相对链接通过；`git diff --check`、`pnpm check`、`pnpm build`、53 文件/475 测试通过；Patch Guard `observed`、0 violations |

## 范围外

- 分布式队列、多节点 worker、远程索引服务。
- 向量检索、embedding、reranker、链接图和学习排序。
- 开放 Web、公共垂直索引管理 API/MCP 和生产托管 rollout。

## 最终证据

- Node.js 25.9.0：`pnpm check` 与 `pnpm build` 通过。
- 全量测试：53 个测试文件、475 个测试通过；包含真实 Chrome、500 页并发和 1,000 页 SIGKILL 恢复。
- 新增垂直搜索聚焦测试：10 个；索引聚焦测试：5 个。
- 活文档：8 份文档的 56 个相对链接全部存在。
- Patch Guard：12 个任务相关文件，`observed`，0 violations；无删除、无二进制文件。
