# 垂直搜索 Phase 4 查询服务 ADR

状态：Implemented

日期：2026-08-31

关联文档：[一期 ADR](./vertical-search-phase1-adr.md)、
[搜索引擎架构全景](./search-engine-architecture-landscape.md)、
[Phase 4 完成账本](./vertical-search-phase4-ledger.md)

## 1. 目标

Phase 4 的第一步只把已经存在的本地搜索能力变成可审计的公共查询合同：

1. `search_web` 的成功和部分成功返回包含 correlation ID、请求 source、实际执行来源，以及查询开始前
   采样的本地检索版本和文档数；没有执行本地检索时该快照为 `null`。
2. 新增只读 MCP 工具 `get_search_status`，无需执行查询即可报告本地索引是否可用、文档数、Web Provider 和本地检索实现版本。
3. CLI、MCP 和应用继续复用同一个 `SearchService`，不增加第二套查询实现。

## 2. 决策

仓库已经通过 MCP 暴露 `search_web`，并由 CLI 使用同一应用服务，因此本阶段不增加 HTTP REST
框架。`SearchService.searchWeb` 在现有 local、web 或 auto 查询上记录实际执行证据；Provider 原始合同不需要
理解本地执行信息。`SearchService.status` 只读取现有索引计数和已配置的 Provider 名称，不探测网络健康。
没有本地索引和 Web Provider 时返回 `unavailable`，否则返回 `ready`。

本地实现版本固定为 `local-fts5-v1`。它表示当前查询算法合同，不假装是尚未实现的索引快照版本；真正的
索引构建、发布和回滚由长期数据层后续合同负责。

## 3. 错误与隐私

- 本地索引关闭时明确返回 `localIndexAvailable=false`、`localDocuments=null` 和
  `retrievalVersion=null`，不伪造空索引。
- `get_search_status` 的存储读取错误继续通过现有 MCP `isError` 结构返回，不降级为成功。
- correlation ID 只关联本次成功或部分成功响应，不宣称是持久审计日志；失败继续使用结构化错误。
- 执行证据不包含查询正文副本、文件路径、Seed、凭证或 Provider 地址。
- `get_search_status` 是只读、幂等工具，不增加管理或写入能力。

## 4. 范围外

- REST/GraphQL/gRPC 服务。
- API Key、限流、组织、RBAC、账单和多租户。
- 索引快照、发布、回滚和分片。
- 向量检索、embedding、reranker 或搜索质量收益声明。

## 5. 验收

- 本地查询返回 UUID correlation ID、实际执行来源，以及查询开始时的本地文档数和 `local-fts5-v1`。
- 显式 Web 查询和 `auto` 后续页不声称执行了本地检索。
- 未启用本地索引时，status 明确区分 unavailable 与空语料。
- MCP 能列出并调用 `get_search_status`。
- 聚焦测试、类型检查、构建、全量测试和 Patch Guard 审核完成。
