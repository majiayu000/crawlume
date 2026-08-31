# 垂直搜索 Phase 5 查询 SLO 证据 ADR

状态：Implemented

日期：2026-08-31

关联文档：[Phase 4 查询服务 ADR](./vertical-search-phase4-adr.md)、
[Phase 5 查询 SLO 完成账本](./vertical-search-phase5-slo-ledger.md)

## 1. 目标

本阶段只建立本地、可审计的查询服务证据，不预设或宣称产品 SLO 已达标：

1. 每次通过参数校验的查询记录请求 source、最终 `ok` / `partial` / `failed`、实际执行来源、
   时长、结果数、警告数和结构化失败码。
2. 新增只读 MCP 工具 `get_search_stats(days)`，报告观测请求量、完整率、可用率、
   p50 / p95 / max 时延、source 分布和失败原因。
3. 指标与现有应用使用同一 SQLite 文件，最多保留 90 天样本，以支持准确分位数和有界查询窗口。

## 2. 决策

新增 `SearchServingMetrics` 作为单一持久化边界。`SearchService` 在参数校验后开始计时；成功和
部分成功从既有 query trace 读取实际执行来源，失败只记录已知的请求 source 和错误码，执行来源标为
`unobserved`，不猜测未完成路径。指标写入失败会显式抛出，不静默丢失 SLO 证据。

`completeRate` 只计算 `ok / requests`，`usableRate` 计算 `(ok + partial) / requests`；两者是观测值，
不是上线门槛。分位数采用保存样本的 nearest-rank 结果。无样本窗口的 rate 和 latency 返回 `null`。

## 3. 隐私与错误

- SQLite 表不含 query、URL、标题、摘要、结果正文、Provider 名称或地址、引擎、correlation ID、
  凭证和原始错误消息。
- 无法确认实际执行来源的失败记录为 `unobserved`，不伪造 local 或 web 执行。
- 非法查询参数在可信边界直接失败，不进入服务 SLO 样本，避免把调用方校验错误混入查询执行质量。
- `days` 只接受 1 到 90 的整数；存储或统计错误继续通过现有 MCP `isError` 合同显式返回。

## 4. 范围外

- 硬编码 SLA / SLO 阈值、达标判定、告警和自动发布门槛。
- 查询内容审计、用户追踪、Provider 探活或网络日志。
- REST、认证、限流、组织、账单和多租户。
- 外部时序数据库、日志平台或分布式指标管道。

## 5. 验收

- `SearchService` 为 `ok`、`partial` 和 `failed` 记录一次且仅一次服务证据，非法参数不记录。
- 重启后统计仍可读取；空窗口返回 `null` rate / latency。
- p50、p95、max、source 分布和失败原因来自持久样本。
- 持久数据不包含测试注入的 query、URL、正文、Provider、correlation ID 或错误消息。
- MCP 能列出并调用 `get_search_stats`，错误保持结构化且可见。
