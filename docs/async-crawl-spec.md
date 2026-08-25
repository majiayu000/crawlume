# Diaoyan v0.5 异步抓取任务规范

## 目标

把现有同步 `crawl_site` 包装为可持久化、可查询、可取消、可在进程重启后恢复的抓取任务。
这是爬虫服务化的第一步，不在本阶段引入 Redis、RabbitMQ、多机 Worker 或代理池。

## 对外接口

新增 MCP 工具：

- `start_crawl`：接收与 `crawl_site` 相同的抓取参数，持久化任务并立即返回任务快照。
- `get_crawl`：按 `jobId` 返回输入、状态、时间、结果或结构化错误。
- `cancel_crawl`：取消排队任务，或向正在执行的任务发出协作式取消信号。

保留现有同步 `crawl_site`，不改变其输入和返回契约。

## 状态机

```text
queued -> running -> completed
                  -> failed
                  -> cancelled
queued ----------------> cancelled
```

任务状态只有 `queued`、`running`、`completed`、`failed`、`cancelled`。页面级部分失败仍由
`CrawlSiteResult.status = partial` 表示，任务本身属于 `completed`，避免混淆任务执行状态与页面结果质量。

## 持久化

在现有 `cache.sqlite` 中增加 `crawl_jobs` 表：

- UUID 主键。
- 输入 JSON、状态、创建/开始/完成时间。
- 结果 JSON或标准化错误 JSON。
- `cancel_requested` 标志。

启动时：

- 上次处于 `running` 且未要求取消的任务重置为 `queued`。
- 已写入取消请求的中断任务转为 `cancelled`。
- Worker 自动继续处理队列。

任务领取使用 `BEGIN IMMEDIATE` 事务和条件更新。当前版本要求每个数据目录只有一个主动服务
进程；普通 CLI 以非 Worker 模式打开应用，不恢复或执行队列，避免和 MCP 服务争抢任务。

## Worker

- v0.5 默认单 Worker，保持现有站点串行抓取和浏览器 Profile 安全边界。
- 入队直接唤醒 Worker，不做固定间隔空轮询。
- Worker 连续领取队列直到为空。
- 任务失败写入标准化错误，不吞异常。
- 应用关闭时向当前任务发出停止信号，等待它退出，然后把任务重新排队，而不是误标为用户取消。

## 取消

`SiteService.crawlSite` 在每个页面读取前后检查内部 `AbortSignal`。当前正在进行的单次 HTTP 或浏览器
导航仍受既有超时限制；取消会在该次读取结束后生效。后续阶段再把信号下传到 transport。

## 安全边界

- 任务输入继续走现有 MCP schema、URL policy、robots、抓取范围和页数上限。
- 不保存 Cookie、令牌或浏览器 Profile 内容，只保存 Profile 名称。
- `JOB_NOT_FOUND` 必须显式失败。
- 进程恢复、取消和 Provider 失败不得转换成伪成功。

## 影响文件

- `src/jobs.ts`：SQLite Job Store 和单 Worker 调度器。
- `src/types.ts`、`src/errors.ts`：任务契约与稳定错误码。
- `src/site.ts`：协作式取消检查。
- `src/app.ts`、`src/mcp.ts`：生命周期和三个异步工具。
- `tests/jobs.test.ts`、`tests/mcp.test.ts`：状态机、恢复、取消与 MCP 契约。
- `README.md`、`docs/spec.md`、`docs/roadmap.md`：使用说明和路线图。

## 验收

- `start_crawl` 在抓取完成前返回持久化 job ID。
- 成功任务最终包含完整 `CrawlSiteResult`。
- 抓取异常最终包含标准化错误。
- 排队和运行任务可取消。
- 模拟进程中断后 `running` 任务可恢复为 `queued`。
- 应用关闭后不遗留错误的 `running` 状态。
- 类型检查、构建和全部单元测试通过。
