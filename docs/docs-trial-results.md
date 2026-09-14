# Crawlume 五站文档试用：2026-09-09

## 结论

后续更新：下述正文代码问题已在同日修复，20 页中的 397 个可见源码块通过 Markdown 解析后的逐块对照。当前日常使用聚焦网页读取与抓取，搜索保持关闭。详见 [代码正文修复与 MCP 接入验收](./code-content-verification.md)。以下三轮数据保留为修复前的试用记录。

已跑通精确 URL 采集、持久任务、本地索引、离线复评和真实 MCP stdio 查询。20 个目标页面全部入库；预先冻结的英文检索词 20/20 命中，19 题首位、HTTPX Clients 第二位。中文问题原文仍为 0/20。

本轮结束时可以用于查找这些文档的相关说明，但还不能宣称完整、可直接复制的代码资料库。MCP 代码块丢失和其他站点代码格式损失仍未解决。

这是一组 Agent 编写的开发任务问题与人工选定的目标页，不是用户真实查询日志；只有 20 个目标页，无检索干扰语料。100% 仅指这个小语料集的目标页 Hit@10，不能外推到自然语言、自动发现、全站覆盖或开放 Web。

## 三轮结果

| 轮次 | 入库页面 | 英文词 Hit@10 | MRR@10 | 发现 |
| --- | ---: | ---: | ---: | --- |
| 原始版本 | 15/20 | 75% | 0.725 | 四个 MCP 页面误报验证码，Playwright Locators 误报登录墙 |
| 访问门检测修复后 | 20/20 | 80% | 0.775 | MCP 被错误选为标题元数据，正文只有 7–12 字符 |
| 两项修复后 | 20/20 | 100% | 0.975 | 四个 MCP 页面正文达到 4,321–12,626 字符，但代码示例仍有遗漏 |

三轮的中文原文 Hit@10、MRR@10 均为 0。每题仅标一个目标 URL，因此 Recall@10 与 Hit@10 相同。各轮为独立数据库上的实时抓取；网站内容可能变化，不是冻结网络输入的对照试验。

## 站点发现试用：2026-09-10

从五个官方首页抓取，不预置 20 个精确 URL。当时深度 2、每域最多 100 页。

| 项 | 结果 |
| --- | ---: |
| 索引页 | 358 |
| 发布页 | 376 |
| 目标页发现 | 16/20 |
| 英文词 Hit@10 | 80% |
| 英文词 MRR@10 | 0.654 |
| 中文原文 Hit@10 | 0% |

未发现的全是 MCP 规范页（tools/resources/prompts/transports）。Playwright、TypeScript、HTTPX、Vite 的目标页都进了索引，且英文词均在 Top 10。HTTPX Clients 从精确语料的第 2 名落到第 4 名，说明干扰页会改变排序。这不能外推到开放 Web。

## 已修复

- 访问门检测以前扫描全部 DOM textContent，脚本中的 CaptchaProvider 与代码示例中的 Sign in / Sign up 触发误判。generic-content-v2 排除脚本、样式、模板和代码示例的文字，保留真实密码表单与可见门禁检测。新增用例先复现失败，再验证修复及真实门禁仍被拒绝。
- JSON-LD 提取器以前允许标题、摘要或空白 articleBody 产生正文候选，并优先于网页正文选中。json-ld-v2 要求非空 articleBody 或 text；只含元数据的对象不产生正文候选。新增标题、摘要和空白正文三种回归。

## 每题正文核对

这里只核对回答该题所需的关键说明及明显代码问题，不代表逐字校对整个网页。

| ID | 官方来源 | 英文词排名 | 人工核对 |
| --- | --- | ---: | --- |
| mcp-1 | [MCP](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | 1 | 执行错误与协议错误的区别、isError 说明存在；JSON 示例丢失。 |
| mcp-2 | [MCP](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) | 1 | resources/list 与 resources/read 说明存在；请求和响应示例丢失。 |
| mcp-3 | [MCP](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts) | 1 | 参数定义与 prompts/get 说明存在；JSON 参数示例丢失。 |
| mcp-4 | [MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | 1 | stdio 与 Streamable HTTP 的传输说明存在；未证明整页代码完整。 |
| playwright-1 | [Playwright](https://playwright.dev/docs/locators) | 1 | getByRole 与 name 的说明及示例存在；代码行被合并。 |
| playwright-2 | [Playwright](https://playwright.dev/docs/actionability) | 1 | Visible、Stable、Receives Events、Enabled 条件均保留。 |
| playwright-3 | [Playwright](https://playwright.dev/docs/auth) | 1 | storageState 保存与配置复用的依据存在；代码行被合并。 |
| playwright-4 | [Playwright](https://playwright.dev/docs/network) | 1 | route 与 fulfill 的调用示例存在；代码行被合并。 |
| typescript-1 | [TypeScript](https://www.typescriptlang.org/docs/handbook/2/narrowing.html) | 1 | pet is Fish 类型谓词及其缩小类型的说明保留。 |
| typescript-2 | [TypeScript](https://www.typescriptlang.org/docs/handbook/2/generics.html) | 1 | Lengthwise 接口和 Type extends Lengthwise 示例保留。 |
| typescript-3 | [TypeScript](https://www.typescriptlang.org/docs/handbook/2/keyof-types.html) | 1 | keyof 生成键的字面量联合类型的说明保留。 |
| typescript-4 | [TypeScript](https://www.typescriptlang.org/docs/handbook/utility-types.html) | 1 | Pick 与 Omit 的定义和示例保留。 |
| httpx-1 | [HTTPX](https://www.python-httpx.org/advanced/timeouts/) | 1 | 四类超时说明与 httpx.Timeout 示例保留；代码格式退化为内联。 |
| httpx-2 | [HTTPX](https://www.python-httpx.org/async/) | 1 | AsyncClient、async with、await client.get 示例保留；代码格式退化为内联。 |
| httpx-3 | [HTTPX](https://www.python-httpx.org/advanced/clients/) | 2 | 连接池复用 TCP 连接的解释保留；目标页排名第二。 |
| httpx-4 | [HTTPX](https://www.python-httpx.org/quickstart/) | 1 | json 请求参数和 raise_for_status 的用法保留；代码格式退化为内联。 |
| vite-1 | [Vite](https://vite.dev/guide/env-and-mode) | 1 | VITE_ 与 import.meta.env 的公开变量说明保留。 |
| vite-2 | [Vite](https://vite.dev/guide/build) | 1 | Public Base Path 部分的 base 配置说明保留。 |
| vite-3 | [Vite](https://vite.dev/guide/static-deploy) | 1 | 构建与 vite preview 的用途及非生产服务器说明保留。 |
| vite-4 | [Vite](https://vite.dev/guide/features) | 1 | 仅转译、不执行类型检查的说明保留。 |

## 下一步按证据排序

1. 修复正文代码保留。已在 [代码正文修复与 MCP 接入验收](./code-content-verification.md) 完成；本文件保留修复前的试用记录。
2. 明确中文查询使用方式。中文问句对英文语料零命中时返回 `LEXICAL_LANGUAGE_MISMATCH`。
   自动翻译或跨语言改写仍然没有实现，Agent 应继续提炼英文检索词。
3. 扩大到含无关页面的站点发现试用。2026-09-10 第一轮（深度 2、2025-06-18 金标）：358 个索引页、16/20 目标页、英文 Hit@10 80%。同日第二轮（深度 3、当前规范金标、跳过静态资源）：369 个索引页、19/20 目标页、英文 Hit@10 95%。未发现的是 MCP `basic/transports`。无界 `llms.txt` 入队会让历史版本占满预算。2026-09-14 在只保留最新日期版本后实跑：372 个索引页、20/20 目标页、英文 Hit@10 100%、MRR@10 0.796。中文原文仍为 0。本地报告在 `benchmarks/reports/docs-trial-discovery-20260914/`（gitignored）。

## 使用与证据

- 复跑说明：[docs-trial.md](./docs-trial.md)。
- 题集：[cases.json](../benchmarks/docs-trial/cases.json)。
- 最终逐题结果：[report.md](../benchmarks/reports/docs-trial-20260909-final/report.md)。
- 最终原始证据：[report.json](../benchmarks/reports/docs-trial-20260909-final/report.json)。
- MCP 客户端证据：[mcp-evidence.json](../benchmarks/reports/docs-trial-20260909-final/mcp-evidence.json)。
- 原始轮次保留在 benchmarks/reports/docs-trial-20260909/ 与 docs-trial-20260909-v2/。
- 当前可用语料数据库在 ~/Library/Application Support/crawlume/docs-trial-20260909-final/cache.sqlite。

benchmarks/reports/ 为本地 gitignored 产物；克隆仓库后需要按说明重跑，报告链接才会存在。没有启用后台定时采集，也没有安装或覆盖客户端 MCP 配置。

验证：pnpm check、pnpm build、全量 60 文件/519 测试通过；离线复评得到相同排名；独立 MCP 进程 20/20 英文词查询命中、trace 均为 local，并完成 HTTPX AsyncClient 的 cache-only 正文读取。本机缓存读取仍执行 DNS 公网策略，需要显式 Fake-IP 配置。
