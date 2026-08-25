# RSL OLP 与 CAP 实现规格（v0.10.3）

## 目标

为长期运行的 Agent 提供 RSL 1.0 的最小安全授权闭环：从站点声明的 HTTPS License Server 获取 OLP License Token，并在受保护资源请求中使用 CAP `Authorization: License <token>`。

本版本不自动购买许可，不实现结算、License introspection、EMS 解密或客户端注册。

## 管理员凭据

默认从 `<data-dir>/rsl-clients.json` 读取，也可通过 `DIAOYAN_RSL_CLIENTS_PATH` 指向绝对路径：

```json
{
  "version": 1,
  "clients": [{
    "server": "https://licenses.example.com",
    "clientId": "diaoyan-client",
    "clientSecret": "replace-with-secret"
  }]
}
```

- 文件不存在表示没有配置 OLP 客户端，相关读取返回 `RSL_LICENSE_REQUIRED`。
- POSIX 系统要求文件不能被 group 或 other 读取、写入或执行，推荐权限 `0600`。
- `server` 必须是 HTTPS URL，不得包含用户名、密码、query 或 fragment；末尾 `/` 会被统一移除。
- 一个规范化后的 License Server 只能配置一个客户端。
- 凭据启动时读取一次；修改后必须重启服务。
- MCP、普通 CLI、审计记录和返回结果都不暴露凭据。

## OLP `/token`

- Token Endpoint 为规范化 License Server URL 后追加 `/token`。
- 请求使用 `POST` 和 `application/x-www-form-urlencoded`。
- 参数为 `grant_type=client_credentials`、完整 `<license>` XML、`license_type=application/rsl+xml` 和父 `<content>` 的原始 `url` 值。
- 客户端认证使用 HTTP Basic；client ID 和 secret 均先按 OAuth 2.0 表单编码，再拼接并 Base64。
- License Server 和 Token Endpoint 必须通过现有 URL/SSRF 策略。
- Token 请求始终直连，不使用网页抓取代理，不跟随重定向，响应上限为 64 KiB。
- 成功响应必须是 JSON，`token_type` 必须精确为 `License`，`access_token` 必须为非空单行字符串，`expires_in` 必须为非负安全整数。
- Token 被视为不透明 secret，只缓存在进程内存中。有限期 Token 提前少量失效；`expires_in=0` 仅在当前进程生命周期内视为不过期。
- 实际使用 CAP Token 取得的正文不写入持久页面缓存或本地全文索引，后续读取必须重新验证当前授权。
- 同一 server、license hash、resource 和 client 的并发获取合并为一个请求。
- Token Endpoint 的响应正文、错误描述、Basic Header 和 Token 都不得进入错误详情或日志。

## 许可边界

自动 Token 获取只适用于：

- 当前 usage、user class 和 geo 已满足；
- 没有禁止条款；
- 没有金额、自定义许可、付款方式、purchase、subscription、training、crawl、use 或 contribution 付款条款；
- attribution、standard URL、legal 或 terms URL 等义务已经通过 v0.10.2 的精确审批；
- 没有 reporting 义务；
- License Server 有精确匹配的管理员凭据。

任何付费或报告场景继续 fail closed。凭据文件只授权向指定服务器认证，不等价于付款许可或对任意条款的批准。

## CAP Header 与重定向

- 资源请求使用 `Authorization: License <token>`。
- 每次主文档请求和每个重定向目标都重新执行 URL、robots 和 RSL 判断。
- Header 不会因为同 origin 或重定向自动继承；只有目标本身的 RSL 决策返回对应 Token 时才发送。
- 401/402 响应通过 RSL Link 或 inline RSL 声明 License Server 时，HTTP 读取最多进行一次带 Token 的挑战重试。
- 重试后的响应若仍拒绝、要求不同 Token 或改变授权目标，显式失败，不循环获取或重试。
- 已带 Token 仍收到 401/402 challenge 时，内存中的旧 Token 会失效并在同一次重试预算内刷新。
- 浏览器模式只为主 frame 导航注入 CAP Header，绝不注入子资源。

## 证据与审计

- `RslEvidence.licenseTokensApplied` 只记录最终成功读取实际使用的 Token 数量，不包含 Token 或 client ID。
- 访问审计继续只记录 URL、结果、RSL 状态、错误码和时间，不记录 Token、凭据、页面正文或 OLP 响应。

## 暂不实现

- 自动注册客户端。
- 预算、付款、退款、账单和结算。
- `/introspect`、`/key` 与 EMS。
- Token 落盘或跨实例共享。
- 多个 License Token 同时组合到一个资源请求。

## 规范来源

- [RSL 1.0 Recommendation](https://rslstandard.org/rsl)
- [OAuth 2.0 Client Credentials, RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)
- [HTTP Basic Authentication, RFC 7617](https://www.rfc-editor.org/rfc/rfc7617)
