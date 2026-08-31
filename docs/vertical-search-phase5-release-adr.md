# 垂直搜索 Phase 5 本地索引发布 ADR

状态：Implemented

日期：2026-08-31

关联文档：[Phase 2 数据层 ADR](./vertical-search-phase2-adr.md)、
[Phase 4 查询服务 ADR](./vertical-search-phase4-adr.md)、
[Phase 5 动态账本](./vertical-search-phase5-release-ledger.md)

## 1. 目标

本阶段只补齐单机 SQLite 本地索引的最小发布闭环：为当前 FTS 投影创建不可变、内容可验证的
release manifest；由调用方显式激活完整 release；把当前投影回滚到仍然完整可重建的既有 release。
投影切换和 active release 指针必须位于同一事务。

## 2. 复用与边界

- `raw_objects` 与 `artifacts` 继续拥有不可变正文，manifest 只保存历史观察和内容依赖引用。
- `indexed_page_history` 提供准确到 request ID 的发布观察；`indexed_pages` 与 FTS5 仍是唯一当前投影。
- release 元数据与 active 指针保存在现有 SQLite 文件，不增加数据库、对象存储或第二套索引。
- 不增加自动 rollout、远程发布、分片、备份、兼容层或管理 API。

## 3. Manifest 合同

manifest 固定记录 schema/indexer 版本、文档数，以及按 final URL 排序的 request、Artifact、Raw、
content hash、完整投影 hash、parser 和 validator 引用。release ID 与 manifest hash 均由规范 JSON 的
SHA-256 导出，创建时必须逐条核对当前投影、历史观察、Artifact 和 Raw 依赖。激活和读取 active 时
重新验证完整投影 hash、Raw 内容地址与全部依赖。空投影、不完整依赖或相同 manifest
的重复发布显式失败。已保存 manifest 禁止更新或删除；读取和激活时重新验证 hash 与内容依赖。

## 4. 激活与回滚合同

创建 release 不改变查询投影或 active 指针。激活只接受状态为 `complete` 且当下仍可完整重建的
release。回滚要求已经存在 active release，并使用相同完整性检查恢复指定的其他 complete release。

重建步骤、FTS trigger 更新和 active 指针更新位于一个 `BEGIN IMMEDIATE` 事务。任何解析、依赖、
容量或 SQLite 写入错误都回滚整个事务，保留操作开始前的当前投影与 active release。
普通索引写入会在同一写事务内清除旧 active 指针，避免旧 manifest 被误报为当前投影；显式激活
在完成全部投影写入后重新设置目标指针。

## 5. 验收

- 空投影和重复 manifest 显式失败，manifest 不复制正文且可检测存储篡改。
- 创建不自动激活；激活状态跨进程重开持久化。
- 回滚只接受已存在、complete、依赖完整且与 active 不同的 release。
- 激活写入中途失败时，查询结果与 active release 均保持不变。
- active 读取拒绝已失去依赖的 release；Artifact 投影或 Raw 内容地址篡改在激活前失败。
- 聚焦测试、相关回归、类型检查、构建和 Patch Guard 产生新鲜证据。
