# Diaoyan v0.7 管理员代理池规范

## 目标

允许管理员把自建或已有的 HTTP(S) 出站代理接入 HTTP 和浏览器抓取路径，提高跨网络环境的可达性。
本能力不提供代理、不自动购买服务、不轮换身份绕过访问拒绝，也不在 Agent 工具参数中接受任意代理地址。

## 配置

新增 `DIAOYAN_PROXY_URLS`，使用逗号分隔一到多个完整代理 URL：

```text
http://proxy-a.internal:8080,https://user:password@proxy-b.internal:8443
```

规则：

- 只允许 `http` 和 `https`。
- 拒绝 path、query 和 fragment。
- 凭证允许存在于环境变量，但不得出现在 MCP、CLI 结果、日志、错误 details 或文档示例真实值中。
- 未配置时保持直连行为。

## 选择策略

- 无授权 Profile 的页面抓取按进程内 round-robin 获取代理。
- 一次 HTTP 请求及其重定向固定使用同一代理。
- 浏览器一次启动及其全部子资源固定使用同一代理。
- 使用 `authProfile` 时，根据 Profile 名称稳定哈希到一个代理，保证跨进程重启仍选择同一出口。
- 手动创建授权 Profile 的 `diaoyan-auth` 使用同样的稳定选择规则。

## HTTP 路径

- 每个代理 URL 创建并复用一个 Undici `ProxyAgent`。
- 目标 URL 在发送前仍执行现有 DNS/SSRF 公网校验，重定向逐跳重新校验。
- 代理只影响出站传输，不允许访问原本被 URL policy 拒绝的目标。

## 浏览器路径

- 将选中的代理拆分为 Playwright `server`、`username` 和 `password`。
- 浏览器网络拦截继续校验主导航和子请求的 URL policy。
- 代理凭证只进入启动参数，不进入返回证据。

## 证据与失败

- 新鲜成功结果的 `evidence.proxyUsed` 只返回布尔值。
- 不返回代理地址、用户名、密码或池索引。
- 代理连接错误沿用 `UPSTREAM_ERROR` / `FETCH_TIMEOUT`，继续受 v0.6 有界重试控制。

## 当前边界

- 池状态为单进程内 round-robin，不进行代理健康检查、熔断或跨 Worker 全局协调。
- robots 请求独立选择代理；页面请求和 robots 请求可能不是同一出口。
- 每个数据目录仍只允许一个主动 Crawl Worker 服务。

## 影响文件

- `src/proxy.ts`：配置解析、凭证拆分、round-robin 和 Profile 稳定选择。
- `src/config.ts`、`src/app.ts`：管理员配置和共享池实例。
- `src/fetch/http.ts`、`src/fetch/browser.ts`：两条抓取路径接入。
- `src/cli/auth.ts`：授权 Profile 使用稳定代理。
- `src/types.ts`：布尔证据。
- `tests/proxy.test.ts` 及聚焦路径测试。
- `README.md`、`docs/spec.md`、`docs/roadmap.md`。

## 验收

- 未配置时 HTTP 和浏览器保持直连。
- 普通租约按顺序轮换并回绕。
- 同一 Profile 始终获得同一代理。
- 非法协议和带 path/query/fragment 的 URL 启动失败。
- Playwright 配置正确拆分 percent-encoded 凭证。
- 返回结果只出现 `proxyUsed`，不泄露配置。
- 类型检查、构建和全部测试通过。
