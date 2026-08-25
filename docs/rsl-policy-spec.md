# Diaoyan v0.10.1 RSL 核心发现与策略规范

> 本文保留 v0.10.1 核心策略边界；v0.10.3 的 Token 获取与 CAP 请求见 `rsl-olp-cap-spec.md`。

## 目标

在页面正文进入提取、缓存或 Agent 上下文之前，发现并执行 RSL 1.0 的机器可读许可约束。
首版实现稳定的 RSL Core 发现、XML 解析和保守决策，不自动购买许可、不自动接受合同，也不实现 OLP Token。

## 管理员上下文

| 变量 | 默认值 | 规则 |
|---|---|---|
| `DIAOYAN_RSL_USAGE` | `ai-input` | `ai-train`、`ai-input`、`ai-index` 或 `search`。 |
| `DIAOYAN_RSL_USER_CLASS` | 空 | 可选：`commercial`、`non-commercial`、`education`、`government` 或 `personal`。 |
| `DIAOYAN_RSL_GEO` | 空 | 可选：两个大写 ASCII 字母的地区代码。 |

用途、用户类别和地区是管理员级事实，不开放为单次 Agent 工具参数，避免调用方为了放行而临时谎报。

## 发现范围

首版检查：

- `robots.txt` 中适用于当前 User-Agent group 的 `License:`；group 内未声明时才使用全局声明。
- 页面响应 `Link: <...>; rel="license"; type="application/rsl+xml"`。
- HTML `<link rel="license" type="application/rsl+xml">`。
- HTML `<script type="application/rsl+xml">` 内联许可。
- `401` / `402` 等响应中的 RSL Link 或 `application/rsl+xml` 正文。

robots 许可在主请求前获取和执行。响应头及 HTML 许可在正文提取前执行。初始 URL 和每次重定向都重新检查 robots 许可。
RSS module 与图片、音频、PDF、EPUB 等容器元数据不在首版范围，因此首版不得宣称完整 RSL Conformance。

## 获取与验证

- 外部许可 URL 必须是绝对 HTTP(S) URL，并经过现有 URL policy、DNS、重定向和响应大小限制。
- RSL 文件上限 1 MB，响应必须是 `application/rsl+xml`。
- 根元素必须是 RSL namespace 下的 `<rsl>`；非法 XML、错误 namespace、缺失必要结构或未知 RSL 核心元素必须显式失败。
- 其他 namespace 的扩展被忽略，不得改变核心语义。
- RSL 文档按 `<rsl max-age>` 缓存；缺省 30 天，只接受正整数天。
- 页面缓存键包含 User-Agent、RSL usage、user class 和 geo，配置变化不得复用旧策略结果。
- 多个适用声明取最严格结果；同一文档内选择匹配目标 URL 的最具体 `<content>` scope，禁止优先于允许。

## 决策

目标用途默认为 `ai-input`。`all` 覆盖全部用途，`ai-all` 覆盖所有 AI 用途。

| 条件 | 行为 |
|---|---|
| 没有发现 RSL | 继续，证据为 `not-declared`；不表示不存在其他法律或站点条款。 |
| 发现的 RSL 没有匹配当前资源 | 继续，证据为 `not-applicable`。 |
| 明确禁止用途、用户类别或地区 | `RSL_PROHIBITED`。 |
| `<permits>` 存在但不包含当前上下文 | `RSL_PROHIBITED`。 |
| `<content server>` 存在 | `RSL_LICENSE_REQUIRED`，等待 OLP/CAP 里程碑。 |
| purchase/subscription/training/crawl/use/contribution 或 amount/custom | `RSL_PAYMENT_REQUIRED`。 |
| attribution、standard、reporting、legal 或 terms | `RSL_CONFIRMATION_REQUIRED`。 |
| 没有上述义务且允许当前上下文 | 继续，证据为 `permitted`。 |
| 声明存在但无法安全获取、解析或判断 | `RSL_INVALID`，不静默忽略。 |

## 证据

新鲜结果的 `evidence.rsl` 返回：

```json
{
  "status": "permitted",
  "usage": "ai-input",
  "discoveredBy": ["robots"],
  "licenseUrls": ["https://publisher.example/license.xml"]
}
```

证据只表示本次读取执行过的机器策略。不得把 `not-declared` 表述为获得许可，不返回 Token、凭证或付款信息。
旧缓存结果可以没有该字段。

## 浏览器边界

浏览器主导航执行同样的 robots、响应头和 HTML RSL 决策，并在最终正文返回前阻断不允许的内容。
首版不解析每个图片、脚本和媒体子资源自己的 RSL 元数据，因此只承诺页面正文读取策略，不承诺通用媒体许可执行器。

## 验收

- robots group/global 选择符合 RSL 规则。
- HTTP Link、HTML link 和 inline script 能被发现。
- 禁止、许可服务器、付款和确认义务分别返回稳定错误码。
- 无声明页面保持现有行为但返回 `not-declared` 证据。
- RSL URL 继续受 SSRF 和大小限制，非法声明不降级放行。
- HTTP、浏览器、重定向与旧缓存证据准确。
- 类型检查、构建和全部测试通过。

## 规范来源

- [RSL 1.0 Recommendation](https://rslstandard.org/rsl)
- [RSL robots.txt guide](https://rslstandard.org/guide/robots-txt)
- [RSL crawler authorization guide](https://rslstandard.org/guide/web-crawlers)
