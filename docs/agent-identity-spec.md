# Crawlume v0.10 Agent 身份与 Web Bot Auth 规范

## 目标

让管理员为 Crawlume 配置一个真实、自有、可公开验证的爬虫身份，并在 HTTP 抓取路径上选择性发送 Web Bot Auth 签名。
本能力用于向站点证明“请求来自哪个 Agent”，不用于冒充 Claude、Googlebot、OpenAI 或其他第三方爬虫，也不承诺绕过付费墙、登录、robots 或站点访问控制。

## 标准状态与兼容边界

- 签名基础使用 RFC 9421 HTTP Message Signatures。
- Web Bot Auth 仍在 IETF 草案演进中；首版只实现 `cloudflare-legacy` 兼容档，与 Cloudflare 当前验证器和官方 `web-bot-auth@0.1.3` 的报文格式一致。
- 当前兼容档发送字符串形式的 `Signature-Agent`，并签名 `@authority` 与 `signature-agent`。
- 后续 IETF 草案档需要使用字典形式的 `Signature-Agent` 和带 `key` 参数的派生组件，不能把当前实现误称为最新草案实现。
- 仅发送签名不等于自动成为“已验证机器人”。管理员仍需在支持方注册自己的 Agent，并公开对应的签名密钥目录。

## 管理员配置

新增以下环境变量：

| 变量 | 默认值 | 规则 |
|---|---|---|
| `CRAWLUME_AGENT_IDENTITY_URL` | 空 | 自有 Agent 的公开 HTTPS 身份 URL；启用签名时必填。 |
| `CRAWLUME_WEB_BOT_AUTH_JWK_PATH` | 空 | Ed25519 私钥 JWK 文件的绝对路径；配置后启用 HTTP 签名。 |
| `CRAWLUME_WEB_BOT_AUTH_PROFILE` | `cloudflare-legacy` | 当前只接受 `cloudflare-legacy`。 |
| `CRAWLUME_WEB_BOT_AUTH_TTL_SECONDS` | `60` | 每个签名的有效期，允许 10 至 300 秒。 |

约束：

- 未配置 JWK 路径时签名完全关闭，保持现有请求行为。
- 配置 JWK 路径时，身份 URL 必须是公网语义的 `https:` URL，不允许用户名、密码、query 或 fragment。
- JWK 文件必须是普通文件，且在 POSIX 系统上不得对 group 或 other 开放任何权限。
- 首版只接受 `kty=OKP`、`crv=Ed25519` 且包含 `x`、`d` 的私钥 JWK。
- 私钥只从文件读取，不接受 MCP/CLI 参数或原始环境变量内容，不进入日志、错误 details、缓存或抓取结果。
- `CRAWLUME_USER_AGENT` 继续代表 HTTP 和 robots 身份。管理员应使用自有产品名和联系地址，不得配置成第三方爬虫名称。

## HTTP 请求行为

启用签名后，每个 HTTP 请求都增加：

- `Signature-Agent: "<CRAWLUME_AGENT_IDENTITY_URL>"`
- RFC 9421 `Signature-Input`
- RFC 9421 `Signature`

签名参数包含 `created`、`expires`、随机 `nonce`、`keyid`、`alg=ed25519` 与 `tag=web-bot-auth`。
`keyid` 是公钥 JWK 的 RFC 7638 SHA-256 thumbprint。

每个重定向目标都必须在 URL/robots 校验之后重新签名，确保签名中的 `@authority` 与实际请求一致。签名异常必须让请求明确失败，不能降级为未签名请求。

## 浏览器与其他请求边界

- 浏览器主导航请求在启用签名时发送与 HTTP 路径相同的 Web Bot Auth 头；子资源请求不签名。
- `evidence.agentIdentity.signed` 表示主文档请求是否带签名，不表示子资源已签名。
- SearXNG 提供方请求不发送页面爬虫签名。
- robots.txt 通过 HTTP transport 获取，因此在启用时使用同一自有身份和签名规则。
- SSRF、DNS、robots、响应大小、超时、代理池和重试策略保持不变。签名不能绕过任何现有策略。

## 返回证据

新鲜页面结果的 `evidence.agentIdentity` 返回：

```json
{
  "userAgent": "Crawlume/0.10 (+https://crawler.example)",
  "identityUrl": "https://crawler.example",
  "signed": true,
  "profile": "cloudflare-legacy"
}
```

规则：

- `signed` 表示最终内容请求是否实际带签名，不表示目标站验证或信任了签名。
- HTTP 与浏览器主导航在签名启用时为 `true`；未配置 JWK 时为 `false`。
- 未配置公开身份 URL 时 `identityUrl` 和 `profile` 为 `null`。
- 不返回私钥、JWK 路径、完整 JWK、代理信息或任何密钥材料。
- 旧缓存条目可能没有该字段，读取时保持向后兼容。

## 公钥发布与站点注册

管理员需要在身份 URL 的 origin 上公开 `/.well-known/http-message-signatures-directory`，其中包含与私钥匹配的公开 JWK，并使用支持方要求的媒体类型。
Crawlume 首版只消费本地私钥并生成请求签名，不替管理员托管公网身份页、密钥目录或完成 Cloudflare 等站点的注册流程。

## 验收

- 默认配置不读取密钥、不发送签名。
- 非 HTTPS 身份、带凭证/query/fragment 的身份 URL、宽松密钥权限或非法 JWK 启动失败。
- 有效 Ed25519 JWK 生成可验证的 RFC 9421 签名，且覆盖正确的 authority 和 Signature-Agent。
- 同一次抓取的每个重定向逐跳重新生成签名。
- 签名器失败时请求失败，不静默回退。
- HTTP 与浏览器主导航在启用签名时均为 `signed: true`；子资源不签名。
- 私钥和路径不出现在返回证据与错误 details 中。
- 类型检查、构建和全部测试通过。

## 规范来源

- [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421)
- [Cloudflare Web Bot Auth verification](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/)
- [IETF Web Bot Auth protocol draft](https://datatracker.ietf.org/doc/html/draft-meunier-webbotauth-httpsig-protocol-00)
- [IETF signature directory draft](https://datatracker.ietf.org/doc/html/draft-meunier-webbotauth-httpsig-directory-00)

`web-bot-auth@0.1.3` 已锁定版本并经过本项目聚焦验签测试，但其上游 README 明确说明尚未完成
独立安全审计。由于该路径处理私钥，投入生产前仍需要人工安全审查。
