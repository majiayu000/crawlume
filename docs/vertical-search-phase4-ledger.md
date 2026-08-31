# 垂直搜索 Phase 4 查询服务完成账本

状态：Complete

开始日期：2026-08-31

本账本只记录 [Phase 4 ADR](./vertical-search-phase4-adr.md) 的最小查询服务闭环。

| ID | 目标 | 状态 | 验证证据 |
| --- | --- | --- | --- |
| S00 | 固定公共查询合同与范围 | Complete | ADR 明确复用 MCP，不增加 REST、认证、计费或索引发布 |
| S01 | 查询执行证据 | Complete | RED→GREEN 验证 correlation ID、请求/实际 source 和查询前本地快照；Web-only 不误报 FTS |
| S02 | 查询服务状态 | Complete | `SearchService.status()` 在无任何后端时返回 `unavailable`，Provider 仅表示 configured |
| S03 | MCP 只读入口 | Complete | `tests/mcp.test.ts` 先因工具缺失失败，后能列出并调用 `get_search_status` |
| S04 | 完整验证与范围审核 | Complete | 聚焦 13/13、check、build、串行全量 53 文件/478 测试通过；Patch Guard 见最终证据 |

## 范围外

- 数据层的索引快照、发布和回滚。
- 检索质量实验与候选 ranker 发布。
- 托管服务认证、限流、组织和账单。

## 最终证据

- Node.js 25.9.0：`pnpm check` 与 `pnpm build` 通过。
- 聚焦测试：`tests/search.test.ts` 与 `tests/mcp.test.ts` 共 13/13 通过。
- 串行全量测试：53 个测试文件、478 个测试通过；包含真实 Chrome、500 页并发和 1,000 页
  SIGKILL 恢复。
- 并行全量运行曾分别出现未修改墙钟测试的资源争用失败；没有修改测试门槛，最终以
  `vitest run --maxWorkers=1` 原样通过完整测试集。
- Patch Guard：8 个任务相关文件，`observed`，0 violations；无删除、无二进制文件。
