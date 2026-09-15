# Crawlume v0.10.2 RSL 批准与访问审计规范

## 目标

为后续 OLP Token 和 CAP 请求建立两个不可省略的安全边界：

1. 只有管理员明确批准、且内容未变化的许可义务可以放行。
2. 每次内容读取成功或失败都留下不含正文和凭证的持久审计记录。

本阶段不调用 OLP `/token`、不发送 CAP Token、不付款，也不提供 Agent 可调用的批准写接口。

## 管理员批准文件

默认路径为 `<CRAWLUME_DATA_DIR>/rsl-approvals.json`，可用
`CRAWLUME_RSL_APPROVALS_PATH` 指向另一个绝对路径。文件不存在表示没有批准；存在时必须是普通
文件，并在 POSIX 系统上拒绝任何 group/other 权限。

格式：

```json
{
  "version": 1,
  "approvals": [
    {
      "licenseHash": "sha256:<64 lowercase hex>",
      "resource": "/articles/",
      "usage": "ai-input",
      "userClass": "personal",
      "geo": "CN",
      "obligations": [
        "attribution",
        "standard:https://creativecommons.org/licenses/by/4.0/"
      ],
      "expiresAt": "2026-12-31T15:59:59.000Z",
      "approvedBy": "operator@example.com"
    }
  ]
}
```

批准必须精确匹配：

- 当前 `<license>` XML 的 SHA-256 Hash。
- `<content url>` 的资源标识。
- 当前 usage、user class、geo。
- 排序并去重后的全部义务。
- 尚未到期的 RFC 3339 UTC 时间。

许可 XML、资源、运行上下文或义务任一变化都会使批准失效。Hash 使用解析后 `<license>` 元素的
稳定 XML 序列化结果，只作为 Crawlume 本地审批标识，不声称是 RSL 标准定义的 canonicalization。

## 可批准与不可批准义务

首版可由静态管理员批准放行：

- `attribution`
- `standard:<opaque URL>`
- `legal`
- `terms:<URL>`

以下情况不能靠批准文件放行：

- 明确禁止的 usage、user class 或 geo。
- `<content server>`，仍需 OLP License Token。
- purchase、subscription、training、crawl、use、contribution、amount、custom 或 payment method。
- reporting，因为确认本身不能完成报告协议。
- user class 或 geo 条件存在但管理员未配置对应上下文。

批准文件只由管理员在 MCP 服务之外管理。MCP 和普通 `crawlume` CLI 不提供 create/update/delete
批准接口，避免远程 Agent 把“读取失败”自行变成“已接受条款”。

## 决策证据

`evidence.rsl` 新增：

```json
{
  "licenseHashes": ["sha256:..."],
  "approvalsApplied": 1
}
```

RSL 阻断错误 details 返回首个适用的 `licenseHash`、`resource` 和逗号分隔的 obligations，帮助
管理员离线审查并创建精确批准。不得返回正文、凭证或未来的 Token。

## 持久访问审计

在现有 `cache.sqlite` 中新增独立 `rsl_access_audit` 表。每次 `read_page`、`inspect_page`、同步或
异步 Crawl 的逐页读取，以及 Monitor 的逐页读取，都记录一个最终结果：

- 时间、请求 URL、最终 URL。
- 成功或失败、错误码。
- fetch method、cache hit。
- RSL status、usage、许可 URL、许可 Hash、批准数量。

不记录正文、标题、摘要、Cookie、Authorization、License Token、私钥、客户端密钥、代理地址或
authProfile 名称。审计写入失败必须让读取显式失败，不能只告警后继续。

新增只读 CLI/MCP 查询，默认最近 100 条，最大 1000 条。查询返回同一安全字段集合，不返回正文
或密钥。访问审计与聚合 metrics 分开，不能用聚合统计替代逐次合规证据。

## 缓存与生命周期

- 批准文件在启动时完整校验并加载；运行中修改需重启服务，避免半次请求使用不同策略。
- 页面缓存键包含批准文件内容 Hash。批准新增、撤销或过期后不得复用旧批准上下文的缓存。
- 审计数据库与 Page Cache 使用同一 SQLite 文件和现有权限边界。
- 应用关闭时必须关闭审计连接；关闭失败进入现有聚合关闭错误。

## 验收

- 缺失批准文件保持保守阻断。
- 宽松权限、非法 schema、重复批准、过期批准和不支持义务启动失败。
- 精确批准可以放行 attribution/standard/legal/terms，任一字段变化都会重新阻断。
- server、付费、reporting、禁止和上下文缺失不能通过批准绕过。
- 成功、缓存成功、RSL 失败和普通抓取失败各写一条安全审计记录。
- CLI/MCP 只读查询有界且不泄露内容或凭证。
- 类型检查、构建、全部测试和依赖审计通过。

## 规范来源

- [RSL 1.0 Recommendation](https://rslstandard.org/rsl)
- [OAuth 2.0 Client Credentials, RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)
- [HTTP Basic Authentication, RFC 7617](https://www.rfc-editor.org/rfc/rfc7617)
