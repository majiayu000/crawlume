# 垂直搜索 Phase 5 本地索引发布动态账本

状态：Complete

开始日期：2026-08-31

本账本只记录 [Phase 5 发布 ADR](./vertical-search-phase5-release-adr.md) 的本地发布闭环；每完成一项
立即更新。

| ID | 目标 | 状态 | 验证证据 |
| --- | --- | --- | --- |
| R00 | 冻结 release、激活、回滚和失败原子性边界 | Complete | ADR 明确复用 Raw/Artifact/history/FTS，排除自动 rollout、远程存储和分布式索引 |
| R01 | 先写边界与事务行为测试并确认真实 RED | Complete | 初始测试 5/5 因 release API 缺失而失败，命中缺失行为；覆盖空投影、重复/篡改 manifest、缺依赖、激活、回滚、持久化和事务失败 |
| R02 | 创建不可变且内容可验证的 complete manifest | Complete | SHA-256 manifest/ID、数据库不可变 trigger、重复/篡改/空投影与 Raw/Artifact/history 逐项核验均由聚焦测试覆盖 |
| R03 | 显式激活与 active 状态持久化 | Complete | 创建后 active 为 null；显式激活后跨 store 重开保留；普通索引写入原子清除过期 active 指针 |
| R04 | 完整性受限的原子回滚 | Complete | complete 旧 release 回滚成功；不存在、building、依赖缺失均失败；注入 INSERT 失败后投影与 active 不变 |
| R05 | 聚焦回归、check/build、Patch Guard 与提交 | Complete | 最终相关回归 23/23、`pnpm check`、`pnpm build`、`git diff --check` 通过；Patch Guard observed 4 个任务文件、0 violations；原子提交包含本账本 |

## 明确范围外

- 自动 rollout、灰度、远程控制面或新的管理 API。
- 备份介质、对象存储、第二个数据库、分片或副本。
- 旧数据回填、迁移兼容或正文复制。

## 最终验证记录

- RED 1：初始 5 个测试因 release API 缺失全部失败；最小实现后 GREEN 5/5。
- RED 2：普通索引改写后旧 active 仍存在；投影变更 trigger 落地后 GREEN 6/6。
- 相关回归：release、page history、index、storage 共 23/23 通过。
- Node.js 25.9.0：`pnpm check`、`pnpm build` 与 `git diff --check` 通过。
- Patch Guard：`observed`，4 个任务相关文件，0 violations；无删除、无二进制文件。
