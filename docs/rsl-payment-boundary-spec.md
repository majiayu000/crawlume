# RSL 付费许可边界规格（v0.10.4）

## 目标

为长期运行的 Agent 提供可审计、不会误扣费的付费许可边界。当前版本严格解析 RSL 静态付款声明，返回结构化 quote，并持久记录预算和结算状态；不执行真实付款。

## 为什么不能把静态 `amount` 当成账单

- RSL `<amount>` 只声明许可中的显式金额。
- RSL `<accepts>` 可以声明 x402 等支付协议，权威价格和结算指令可以在资源服务器的运行时 402 响应中提供。
- RSL OLP `/token` 成功响应只有 Token 类型和有效期，没有实际费用、交易 ID 或结算收据。
- RSL 明确把注册、billing 和 reporting 等运营能力排除在规范范围外。

因此 Crawlume 不得仅凭静态 XML 声称费用已经扣除、预算已经消耗或交易已经结算。

## 严格付款 quote

遇到需要付费的 `<payment>` 时返回 `RSL_PAYMENT_REQUIRED`，错误 details 包含：

- `paymentType`：purchase、subscription、training、crawl、use 或 contribution；缺失时为空。
- `paymentAmount`：规范化前保持原始十进制定点字符串；没有静态金额时为空。
- `paymentCurrency`：三位大写 currency code 形式；没有静态金额时为空。当前只校验语法，不维护会随时间变化的币种注册表。
- `paymentProtocols`：排序、去重后的 `<accepts type>`，用逗号连接。
- `pricingAuthority`：`declared`、`runtime` 或 `unspecified`。
- `budgetStatus`：固定为 `disabled`。
- `settlementStatus`：固定为 `not-attempted`。

验证规则：

- `<amount>` 最多一个。
- currency 必须是三位大写 ASCII 字母。
- 金额必须是大于零、非指数形式、最多 18 位小数的十进制定点数。
- `<accepts>` 必须有合法、单行、有界的媒体类型；最多声明 16 个协议。
- `<custom>` 必须是非空、有界的 HTTP(S) URL 或绝对路径。
- 非法声明返回 `RSL_INVALID`，不得降级成普通付费阻断。

静态 `amount` 且没有 `<accepts>` 时，`pricingAuthority=declared`。存在任何 `<accepts>` 时为 `runtime`，因为动态协议可以提供权威定价和结算指令。两者都没有时为 `unspecified`。

## 审计

现有 `rsl_access_audit` 增加下列安全字段：

- payment type、amount、currency、protocols。
- pricing authority。
- budget status。
- settlement status。

成功的非付费读取写空值；付费阻断写 quote。字段不包含钱包、签名、支付 payload、Token、client ID、付款地址或服务端错误正文。旧数据库自动增加新列，历史记录的 payment 整体为空；只有新的付费阻断记录带有 `disabled` 和 `not-attempted`。

现有 `crawlume rsl-audit` 和 `get_rsl_audit` 返回这些字段，不增加付款写接口。

## 当前预算与结算策略

- 全局预算和单笔预算都处于禁用状态。
- 不创建预算 reservation，不把 quote 计入 spend。
- 不调用钱包、x402 facilitator、支付 Provider 或自定义 licensing endpoint。
- 不因为 OLP client credentials 已配置就允许付费 Token 请求。
- 不自动处理 subscription、training、use、contribution 或 reporting。

## 未来真实付款 adapter 的最低门槛

真实付款属于高风险独立里程碑，必须由管理员显式启用，并同时具备：

1. 精确绑定 license Hash、resource、usage、asset、network、payTo、协议和到期时间的批准。
2. 单笔、每日和项目预算，使用定点或原子单位比较，不使用浮点数。
3. 签名前持久 reservation、幂等键和并发事务。
4. 对动态 quote 做资源、金额、资产、网络、收款方和超时校验。
5. 独立 verify 与 settle 结果；只有可验证 settlement receipt 才计为 settled。
6. unknown/timeout 不释放预算，进入人工 reconciliation。
7. 密钥在外部 wallet/signer 中，永不进入 MCP 参数、日志、SQLite 或仓库。
8. 退款、撤销、重复结算和账实不一致处理。

## 验收

- 合法静态金额返回结构化 `RSL_PAYMENT_REQUIRED` quote。
- x402 或其他 `<accepts>` 标记为 runtime pricing，不解析或执行内嵌指令。
- 非法 currency、金额、媒体类型、custom path 和重复 amount 返回 `RSL_INVALID`。
- 付费条款不会触发 OLP `/token`、钱包或结算请求。
- quote 持久写入审计且不泄露页面、凭据或支付 payload。
- v0.10.3 免费 OLP/CAP 路径保持通过。

## 规范来源

- [RSL 1.0 Recommendation](https://rslstandard.org/rsl)
- [x402 v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
