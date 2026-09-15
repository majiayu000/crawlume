# Crawlume v0.6 域名限速与有界重试规范

## 目标

提高瞬时网络故障、429 和上游 5xx 下的抓取成功率，同时控制对目标站点的请求节奏。策略必须
尊重访问拒绝和 `Retry-After`，不得通过高频重试扩大流量或把最终失败包装成成功。

## 适用范围

- `read_page`、同步 `crawl_site` 和异步 Crawl Job 的页面读取共享同一个进程内策略实例。
- `map_site` 的主页面请求使用相同域名限速和重试。
- robots、重定向、SSRF、内容大小和授权边界保持不变。
- 浏览器页面的子资源不单独计入域名间隔；主导航计入一次尝试。

## 配置

- `CRAWLUME_CRAWL_MAX_ATTEMPTS`：每页最大尝试次数，默认 3，设置 1 可关闭重试。
- `CRAWLUME_CRAWL_RETRY_BASE_MS`：指数退避基数，默认 500ms，可设置 0。
- `CRAWLUME_CRAWL_MAX_RETRY_DELAY_MS`：单次最大允许等待，默认 30000ms。
- `CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS`：同一 hostname 两次尝试的最小启动间隔，默认 250ms，可设置 0。

## 重试规则

1. 只重试 `ReadError.retryable = true` 的失败。
2. 401、402、403、robots 禁止、登录墙、付费墙、挑战页、内容过大和参数错误不重试。
3. 第 N 次失败后的基础等待为 `base * 2^(N-1)`，并受最大等待限制。
4. 429 的 `Retry-After` 为合法秒数或 HTTP 日期时，等待时间取退避与 `Retry-After` 的较大值。
5. 如果 `Retry-After` 超过管理员配置的最大等待，本次调用直接保留 `RATE_LIMITED` 失败，不提前重试。
6. 达到最大尝试次数后抛出原稳定错误码，并在 details 增加 `attempts` 和
   `totalRetryDelayMs`。
7. 等待可被异步 Crawl Job 的取消信号打断。

## 域名间隔

- key 使用规范化 URL 的小写 hostname；不同端口仍属于同一主机策略。
- 每次真实尝试开始前原子预留下一个允许时间，确保同进程并发调用不会同时穿透。
- 不使用固定轮询，等待由单次可取消 timer 完成。
- 当前限制器为进程内状态；多进程/多机全局限速留待服务化阶段。

## 证据

新鲜成功读取的 `evidence` 增加：

- `attempts`：实际尝试次数。
- `totalRetryDelayMs`：因重试等待的计划毫秒数，不含域名间隔等待。

缓存旧记录允许没有这两个新增字段，以保持升级兼容。最终失败在 `ReadError.details` 返回同样的
两个标量。

## 影响文件

- `src/crawl-policy.ts`：共享域名预留、重试判定、退避和可取消等待。
- `src/config.ts`、`src/types.ts`：配置和成功证据。
- `src/reader.ts`、`src/site.ts`、`src/app.ts`：共享策略接入。
- `src/errors.ts`、`src/fetch/http.ts`、`src/fetch/browser.ts`：`Retry-After` 解析和传递。
- `tests/crawl-policy.test.ts` 及聚焦集成测试。
- `README.md`、`docs/spec.md`、`docs/roadmap.md`。

## 验收

- retryable 失败可在上限内恢复成功。
- 非 retryable 失败只尝试一次。
- 达到上限后保留错误码和尝试证据。
- 同主机并发尝试按配置间隔预留，不同主机互不阻塞。
- `Retry-After` 被遵守，超出最大等待时不提前重试。
- 取消可中断退避等待。
- 类型检查、构建和全部测试通过。
