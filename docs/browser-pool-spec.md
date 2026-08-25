# Diaoyan v0.8 浏览器 Worker 池规范

## 目标

避免匿名动态页面每次抓取都启动和关闭 Chrome。浏览器进程按代理出口复用，每次页面抓取创建新的
隔离 BrowserContext，在降低启动成本的同时保留 Cookie、Storage 和页面状态隔离。

## 适用范围

- 无 `authProfile` 的浏览器抓取使用池。
- 使用 `authProfile` 的持久 Context 不进入池，继续按 Profile 串行和独占启动。
- HTTP 抓取不使用浏览器池。

## 配置

- `DIAOYAN_BROWSER_POOL_SIZE`：进程内最大匿名浏览器实例数，默认 2，范围 1-16。
- `DIAOYAN_BROWSER_CONTEXTS_PER_INSTANCE`：每个实例最大并发 Context，默认 4，范围 1-32。
- `DIAOYAN_BROWSER_POOL_WAIT_MS`：池满后的最大等待，默认 30000ms，范围 1-300000。

## 分池与复用

- key 为直连或内部代理 URI；代理凭证不得进入错误、日志和工具结果。
- 同一 key 优先复用已有已连接浏览器。
- 有空余全局实例槽位时，为新 key 启动浏览器。
- 池满但存在空闲的其他 key 浏览器时，关闭该空闲实例并为新 key 建立实例。
- 所有实例均忙时等待 lease；release 后唤醒等待者。
- 浏览器断连后从池移除，下一次 acquire 重新启动。

## Context 隔离

- 每次 lease 只提供 Browser；抓取器立即创建新的无持久化 Context。
- 页面完成或失败时先关闭 Context，再 release lease。
- 浏览器本身仅在淘汰、断连或应用关闭时关闭。

## 等待、取消与失败

- 等待由事件唤醒，不固定轮询。
- Crawl Job 的取消信号下传到 acquire，立即移除 waiter 并返回 `CRAWL_CANCELLED`。
- 超过等待上限返回 retryable 的 `BROWSER_POOL_EXHAUSTED`。
- 浏览器启动失败移除预留 entry，不占用永久容量，并沿用现有浏览器错误归一化。

## 生命周期

- 应用关闭先停止 Crawl Job，再关闭浏览器池。
- `close()` 阻止新 lease，唤醒等待者，并关闭所有已经启动或正在启动的匿名浏览器。
- lease release 幂等，避免 finally 重复释放造成负计数。

## 当前边界

- 池仅在单进程内协调，不是远程 Playwright 集群。
- 不做浏览器预热、空闲 TTL、内存阈值驱逐和任务优先级。
- 授权 Profile 仍每次启动独立持久 Context，后续可单独设计安全的 Profile Worker。

## 影响文件

- `src/browser-pool.ts`：容量、key、lease、等待与关闭。
- `src/config.ts`、`src/errors.ts`：配置和稳定错误码。
- `src/fetch/browser.ts`、`src/app.ts`：匿名抓取接入与生命周期。
- `tests/browser-pool.test.ts`：复用、容量、淘汰、取消、超时和关闭。
- `README.md`、`docs/spec.md`、`docs/roadmap.md`。

## 验收

- 同一出口的连续匿名抓取只启动一次浏览器。
- 同一浏览器不超过 Context 并发上限。
- 不同出口按容量新建或淘汰空闲实例。
- 池满等待可以 release 唤醒、取消或超时。
- 浏览器断连和启动失败不污染池容量。
- 应用关闭后所有匿名浏览器关闭且不能再 acquire。
- 类型检查、构建和全部测试通过。
