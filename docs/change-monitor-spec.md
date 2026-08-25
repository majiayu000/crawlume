# Diaoyan v0.9.1 页面变化监控规范

## 目标

让长期运行的 MCP 服务可以持续读取一个明确授权的页面，用已有 `contentHash` 判断正文是否变化，
并把调度状态、最后结果和错误持久化。变化检测不得引入 LLM、Embedding、第二次抓取或外部队列。

## 对外工具

- `start_monitor`：接收 URL、读取模式、可选授权 Profile 和 60-604800 秒间隔，创建后立即调度。
- `get_monitor`：按 UUID 返回当前状态、下次执行时间、计数和最后一次运行。
- `list_monitors`：返回最近创建的监控，默认 20、最大 100。
- `cancel_monitor`：永久停止一个已创建的监控；取消幂等。

监控不接受缓存策略。每次运行强制 `cacheMode=live`，否则无法证明页面当前是否变化。

## 状态机

```text
scheduled -> running -> scheduled
    |           |
    +-----------+-> cancelled
```

- `scheduled`：等待 `nextRunAt`。
- `running`：当前正在读取。
- `cancelled`：终态，不再调度；如正在运行则发出协作式取消。

监控读取失败不是监控终态。失败写入 `lastRun`，递增失败计数，并在正常间隔后再次调度。

## 变化语义

- 第一次成功读取建立基线，`changed=null`。
- 后续 `contentHash` 与上一成功基线相同，`changed=false`。
- 后续 Hash 不同，`changed=true`，递增 `changeCount` 并更新 `lastChangedAt`。
- 失败不清空或更新成功基线。
- 最后成功只保存不含正文的 `InspectPageResult`；正文继续由现有成功缓存管理。

## 持久化与调度

- 在 `cache.sqlite` 中新增独立严格表，保存 UUID、输入、间隔、状态、时间、计数、Hash 和最后运行。
- 创建时 `nextRunAt=now`。一次运行完成后，从完成时间加间隔，避免慢任务重叠或追赶积压周期。
- 单 Monitor Worker 串行领取到期任务，使用精确 `setTimeout` 等到最近到期时间，不固定频率空轮询。
- 长期 MCP 服务运行 Worker；普通 CLI 进程不恢复或执行监控。
- 服务重启时遗留的 `running` 恢复为立即到期的 `scheduled`。
- 服务关闭时取消当前读取并恢复为 `scheduled`，不能误标为用户取消。

## 取消与失败

- `cancel_monitor` 对 `scheduled` 和 `running` 都写入 `cancelled`；终态重复取消返回同一快照。
- URL policy、robots、付费墙、登录墙、超时和重试规则完全沿用 Reader。
- 页面读取错误标准化后写入 `lastRun`，不得包装成未变化。
- Store 或 Worker 内部故障必须让 Monitor API 显式失败，不能静默停止调度。
- `MONITOR_NOT_FOUND` 是稳定错误码。

## 安全与边界

- 每个监控只读取创建时给定的单个 URL，不自动发现链接或扩大站点范围。
- 不发送 Webhook、邮件或外部通知；Agent 通过 `get_monitor` 或 `list_monitors` 读取状态。
- 不提供删除或重新启用；取消后如需恢复，创建一个新监控。
- 当前单进程、单 Worker，不承诺多机抢占或 exactly-once。
- 监控使用授权 Profile 时仍遵循 Profile 独占串行和既有代理绑定。

## 影响文件

- `src/monitor-store.ts`：SQLite Store 与持久状态机。
- `src/monitors.ts`：事件驱动调度器和 Reader 执行边界。
- `src/types.ts`、`src/errors.ts`：Monitor 契约和稳定错误码。
- `src/app.ts`、`src/mcp.ts`：生命周期和四个 MCP 工具。
- `tests/monitors.test.ts`、`tests/mcp.test.ts`：状态、变化、失败、取消、恢复和接口。
- `README.md`、`docs/spec.md`、`docs/roadmap.md`。

## 验收

- 创建后立即完成一次基线读取并设置下一次执行时间。
- 相同 Hash、不同 Hash 和读取失败分别产生明确结果与计数。
- 失败后仍会继续调度，取消后不再调度。
- Worker 没有固定间隔空轮询，未来任务只注册最近一次计时器。
- 重启恢复运行中任务，关闭不遗留错误的 `running`。
- MCP 可创建、查询、列出和取消监控。
- 类型检查、构建和全部测试通过。
