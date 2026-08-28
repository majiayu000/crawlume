# Diaoyan Reliability Benchmark 规范

状态：Architecture Spec；HTTP baseline、首个 Browser canary 与 Readiness Tournament 已实现，完整内容/Provider baseline 待实现
最后更新：2026-08-28

## 目标

建立一套可重复、可解释、能驱动架构决策的网页读取真值系统。Benchmark 不回答“请求是否返回
200”，而回答“用户是否在给定时间与成本预算内拿到了正确、完整、足够新、可追溯的结果”。

产品优化的唯一总目标是降低单位有效结果成本：

```text
cost_per_valid_artifact = total_execution_cost / valid_artifacts
```

成功率、错误成功率、延迟、浏览器使用率和重试放大率是解释该指标的组成部分，不能分别优化到互相
伤害。例如，默认对所有页面启动浏览器可能提高原始成功率，却会恶化成本和吞吐；把登录页当正文
返回会提高调用成功率，却会降低真实可信度。

## 术语和真值标签

### Eligible request

只有满足以下条件的请求进入有效成功率分母：

- URL、输出目标和预算合法。
- 请求属于 Benchmark 声明支持的内容类型。
- 公开页面允许读取，或测试用授权会话由操作者明确提供。
- 不要求绕过 robots、登录、付费、验证码或访问控制。

策略拒绝、明确不支持和测试环境自身故障单独统计，不能混入产品失败，也不能伪装成成功。

### Outcome

| 标签 | 定义 | 是否计入有效成功 |
| --- | --- | --- |
| `valid` | 所有必需断言通过，结果满足任务目标 | 是 |
| `uncertain` | 可以返回，但至少一个必需维度无法确定 | 否，单独统计 |
| `invalid` | 返回 `ok`，但真值断言证明内容错误或残缺 | 否，计入错误成功 |
| `failed` | 系统明确返回稳定错误，没有伪装成功 | 否 |
| `policy_stop` | robots、许可、登录、付款或人工验证边界要求停止 | 不进入产品失败 |
| `unsupported` | 内容类型或能力不在声明范围内 | 不进入产品失败，但必须可见 |
| `harness_error` | Fixture、网络探针或 Benchmark 本身故障 | 本轮样本无效 |

### Validity dimensions

每个 Case 明确哪些维度是必需项：

- `identity`：最终 URL、标题、实体 ID 或 canonical URL 正确。
- `completeness`：必需段落、项目、页码或字段没有缺失。
- `fidelity`：正文和结构没有被导航、脚本、重复内容污染。
- `freshness`：结果满足 Case 声明的最大年龄。
- `schema`：结构化输出满足版本化 Schema 和字段约束。
- `provenance`：抓取方式、时间、Hash、Adapter 版本和访问上下文可追溯。

## 核心指标

| 指标 | 公式 | 用途 |
| --- | --- | --- |
| Valid Result Rate | `valid / eligible` | 用户真实拿到可用结果的概率 |
| False Success Rate | `invalid / returned_ok` | 最重要的可信度风险 |
| Uncertain Rate | `uncertain / eligible` | 验证器覆盖不足或页面不确定性 |
| Cost per Valid Artifact | `total_cost / valid` | 产品总优化目标 |
| Valid Latency p50/p95 | 有效结果端到端耗时分位数 | 体验与容量规划 |
| Browser Escalation Rate | `browser_started / eligible` | 昂贵路径使用率 |
| Browser Uplift | `http_invalid_then_browser_valid / browser_started` | 浏览器是否真正创造价值 |
| Retry Recovery Rate | `valid_after_retry / retried` | 重试收益 |
| Retry Waste Rate | `failed_after_retry / retried` | 重试浪费 |
| Crawl Coverage | `expected_unique_pages_found / expected_unique_pages` | 站点发现完整性 |
| Duplicate Rate | `duplicate_artifacts / produced_artifacts` | Frontier 和规范化质量 |
| Recovery Loss | 恢复后丢失或重复执行的 Request 数 | 耐久任务正确性 |

`raw success rate` 只作为操作指标保留，不得成为发布门槛或营销数字。

## 成本模型

P0 不估算虚构货币成本，先采集可观测资源代理：

```text
ExecutionCost {
  httpRequests
  networkBytesIn
  networkBytesOut
  browserMilliseconds
  browserContextStarts
  proxyBytes
  cpuMilliseconds
  peakMemoryMb
  storageBytesWritten
  retryAttempts
  retryDelayMilliseconds
  optionalModelTokens
}
```

当部署环境提供真实单价后，由独立 `CostModel` 将这些资源代理换算为金额。Benchmark 原始记录永远
保留资源量，避免价格变化后历史结果失真。

## Corpus 设计

Benchmark 使用三层 Corpus，三者不得互相替代。

### Layer A：Hermetic fixtures

仓库内固定输入，覆盖：

- 静态文章、文档、列表、分页和重复导航。
- JSON、JSON-LD、RSS、Sitemap、纯文本和 PDF。
- JavaScript Shell、延迟正文、Skeleton 和无限滚动的受控变体。
- 登录墙、付款墙、人工验证页和错误页。
- 重定向、canonical、超大响应、断流、乱码和错误 Content-Type。
- 429、`Retry-After`、临时 5xx、超时和浏览器崩溃。

Layer A 用于每次提交的确定性回归，不依赖公网。

### Layer B：Controlled sites

本地测试服务或专用测试域动态模拟网络、DOM 和运行时行为：

- 可配置响应延迟和分块传输。
- 在指定时间插入正文或目标元素。
- 返回可重复的限速和故障序列。
- 模拟进程中断、任务恢复和结果去重。
- 输出服务器端请求计数，用于核对重试和缓存行为。

Layer B 验证调度、等待、恢复和成本，不承担真实网站代表性。

### Layer C：Live canaries

选择公开、稳定、用途明确的真实 URL。真值使用不易漂移的结构断言，而非全文快照：

- 页面标题或 canonical 域名。
- 必需 heading、代码块、表格或正文长度区间。
- Sitemap/Feed 至少包含的已知入口。
- PDF 页数或固定章节。
- 明确的 gate page 必须被拒绝。

Live Case 必须记录最后审核时间和最大有效期；过期 Case 自动进入 `harness_error`，不得将网站改版
算成产品回归。

## 公开标准依据与 Diaoyan 加严项

现有公开 Benchmark 各自只覆盖问题的一部分：

| 依据 | 已解决的问题 | 仍未覆盖的部分 |
| --- | --- | --- |
| [WCXB](https://webcontentextraction.org/) | 2,008 个人工审核页面、1,613 个域名、7 类页面；word-level precision/recall/F1，`with`/`without` snippets，独立 held-out set | 不测 robots、发现覆盖、失败恢复、成本和 Browser 规划 |
| [CleanEval](https://sigwac.org.uk/cleaneval/) | HTML 输入、人工 gold standard、公开 scorer，中英文正文去噪 | 数据较旧，页面类型、动态站点和执行成本覆盖不足 |
| [Mozilla Readability tests](https://github.com/mozilla/readability/tree/main/test/test-pages) | 大量真实正文提取回归 fixture | 主要是 reader/extractor 测试，不是完整 crawler 合同 |
| [Firecrawl DevDex](https://www.firecrawl.dev/benchmarks/devdex) | 固定 gold references、无模型裁判、held-out 部分、memorization gate | 测检索排序，不测页面抓取与正文保真 |
| [Crawl4AI stress benchmark](https://github.com/unclecode/crawl4ai/blob/main/tests/memory/README.md) | URLs/s、处理成功率、并发和内存增长 | “处理成功”没有独立内容真值，无法发现假成功 |
| [WebArena](https://webarena.dev/) | 自托管可复现网站、程序化验证任务最终状态 | 面向 Browser Agent 操作，不是 crawl coverage 或正文提取 |
| [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) | robots 匹配、重定向、缓存与不可达语义 | 是合规协议，不是质量评分 |
| [ISO 28500 WARC](https://www.iso.org/standard/68004.html) | 保存请求、响应、元数据、转换与去重事件的证据格式 | 不规定提取质量或产品 SLO |

Diaoyan 标准不是再造一个平均分，而是把这些互补条件串成一条不可绕过的真值链：

```text
Policy eligible
  -> Fetch evidence complete
    -> Identity and scope correct
      -> Required content complete
        -> Forbidden content absent
          -> Freshness satisfied
            -> Cost and latency counted
              -> valid artifact
```

相比只报告 `HTTP 200`、`success=true`、URLs/s 或单一 word F1，本标准额外要求：

- 合规、范围、证据和假成功是硬门槛，不能被高吞吐平均掉。
- 同时测正文召回和 boilerplate 污染；不能只要求“某段出现”。
- HTTP、Browser、retry 和远程 Provider 的资源全部归因到最终 artifact；失败尝试不能免费消失。
- 冻结离线集、受控故障集、公开 live canary 和私有业务集分层报告，禁止相互替代。
- 开发集与 held-out set 域名隔离；生产代码不得按 URL、Case ID 或已知 snippet 特判。
- 所有竞品必须使用相同输入、地区、预算、超时、输出目标和真值裁判；模型不能给自己的输出打分。

## Diaoyan Web Retrieval Standard v1

### 硬性失格条件

任一条件出现，本轮标为 `disqualified`，不参与速度或价格排名：

1. 请求 robots 明确禁止的 URL，或在未授权情况下跨过登录、付款、验证码和访问控制。
2. 抓取超出 Case scope 的 origin/path，或向未声明第三方发送 Cookie、正文、Token。
3. 将登录页、挑战页、错误页、空壳、残缺正文判为成功。
4. 成功结果缺少最终 URL、时间、方式、状态链、正文 Hash、配置版本或 attempt 账本。
5. 隐藏 retry、Browser 时间、代理流量、模型 token 或商业 API 调用，导致成本不可复算。
6. 使用 Case ID、URL 或 gold snippet 的生产特判，或在 held-out set 上调参。

### 单 Case 判定

Case 只有 `valid` 或非 `valid`，不得用部分分掩盖必需字段失败：

- 所有 `required` snippet 必须出现，所有 `forbidden` snippet 必须缺席。
- 正文类同时计算 normalized word precision、recall、F1；默认三者都不得低于 Case 门槛。
- 结构化字段使用 exact match；金额、日期、URL 先按 Case 声明规范化，不能模糊猜测。
- 列表/站点 crawl 同时满足 expected unique coverage、零 scope leak 和重复率门槛。
- Browser Case 必须由 DOM/字段条件判定 readiness，禁止固定 sleep 充当成功证据。
- gate/error Case 的正确结果是明确的 `policy_stop`、`unsupported` 或 `failed`，不是空正文 `ok`。

### Release 门槛

第一版采用“硬门槛后字典序排名”，不使用可被互相抵消的综合分：先比较合规与假成功，再比较有效率、
内容质量、成本，最后才是延迟。

| 指标 | Release 最低门槛 | Gold 目标 |
| --- | ---: | ---: |
| Policy violations | 0 | 0 |
| Scope/data leaks | 0 | 0 |
| False Success Rate | ≤ 0.5%，且 gate Case 必须为 0 | ≤ 0.1% |
| Valid Result Rate | 全集 ≥ 95%，每类 ≥ 90% | 全集 ≥ 98%，每类 ≥ 95% |
| 正文 word F1 | 全集 ≥ 0.92，每类 ≥ 0.88 | 全集 ≥ 0.95，每类 ≥ 0.92 |
| Required/forbidden snippets | 每个 valid Case 100% 通过 | 100% |
| Crawl Coverage | ≥ 99.5% | ≥ 99.9% |
| Duplicate Artifact Rate | ≤ 0.1% | ≤ 0.02% |
| Provenance completeness | 100% | 100% + 可回放 WARC/WACZ |
| 五次重复 outcome 一致率 | ≥ 99% | ≥ 99.9% |

性能只对 `valid` 结果统计。候选版本若 Cost per Valid Artifact 恶化超过 10%，必须带来至少 2 个百分点
Valid Result Rate 提升，或解决一个 P0 类别失败；否则不能以“更智能”为由接受回归。发布对比使用逐
Case 配对结果和 95% bootstrap confidence interval，同时报告 median、p95、最大值和失败分布。

### Corpus 配额和防污染

正式 Release set 至少包含：

- WCXB 完整 511-page held-out set 用于兼容公开成绩；另从中派生与 dev domains 不重叠的 strict split，
  只用 strict split 决定发布，开发时不得查看其 gold truth。
- CleanEval 中英文 final set 或其许可允许的固定副本。
- 固定 commit 的 Mozilla Readability regression fixtures。
- 不少于 40 个 Layer A/B 故障 Case：robots、redirect、429、5xx、timeout、断流、乱码、错误 MIME、
  JS shell、延迟内容、无限滚动、gate、crash/recovery。
- 不少于 30 个 Layer C public canaries，每个 domain 默认只取一个页面；练习站除外。
- 不少于 30 个私有业务 Case，并保持类别比例与真实流量相近。

Diaoyan strict split 的开发集、公开 canary 和私有 set，其 registrable domain 不得与 strict
held-out set 重叠；WCXB 原始 split 仍单独报告以保持横向可比。Case 变更必须提升 `caseSetVersion`，
保留旧报告；删除失败 Case 不能提高历史分数。

## Public URL Corpus v1 候选

以下 URL 已于 2026-08-28 做可达性与 Content-Type 探针。它们只是候选；每次 live run 仍必须先按
RFC 9309 重新检查 robots 和权限。普通真实站默认只读单页、每 origin concurrency 为 1；只有明确的
scraping sandbox 才允许分页/发现测试。Live truth 30 天复核，sandbox truth 90 天复核。

### 明确用于抓取测试的 Sandbox

| ID | URL | 能力 | 必需真值 |
| --- | --- | --- | --- |
| `book-list-static` | `https://books.toscrape.com/` | 静态列表、分页、图片 | 首页 20 个产品；全站模式 1,000 个 unique books / 50 页 |
| `book-detail-static` | `https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html` | 产品详情、属性 | title、price、availability、rating、description 均存在 |
| `quotes-static` | `https://quotes.toscrape.com/` | microdata、分页 | 首屏 10 条 quote，作者与 tags 绑定正确 |
| `quotes-tableful` | `https://quotes.toscrape.com/tableful/` | 非语义 table 布局 | quote/author/tags 不因布局错配 |
| `quotes-login-gate` | `https://quotes.toscrape.com/login` | CSRF/login gate | 必须识别为授权入口，不得当正文成功 |
| `products-static-pages` | `https://webscraper.io/test-sites/e-commerce/static/computers/laptops` | 静态产品分页 | 产品 title/price/description/reviews 成组，发现分页 |
| `countries-static` | `https://www.scrapethissite.com/pages/simple/` | 大列表、多字段 | country、capital、population、area 行关系不串位 |
| `hockey-forms` | `https://www.scrapethissite.com/pages/forms/` | 表单、分页、表格 | team/year/wins/losses 字段和分页保持完整 |

### Browser 与动态加载 Sandbox

| ID | URL | 能力 | 必需真值 |
| --- | --- | --- | --- |
| `quotes-js` | `https://quotes.toscrape.com/js/` | JS 渲染 | HTTP shell 不得假成功；Browser 后首屏 10 条 quote |
| `quotes-infinite` | `https://quotes.toscrape.com/scroll` | infinite scroll | 滚动后 unique quote 单调增加，无重复 |
| `products-ajax` | `https://webscraper.io/test-sites/e-commerce/ajax/computers/laptops` | AJAX pagination | 切页后产品集变化且字段完整 |
| `products-scroll` | `https://webscraper.io/test-sites/e-commerce/scroll/computers/laptops` | scroll loading | 到终态后产品数稳定，不能只取首批 |
| `products-load-more` | `https://webscraper.io/test-sites/e-commerce/more/computers/laptops` | load-more | 按钮终态与完整 unique 产品集一致 |
| `movies-ajax` | `https://www.scrapethissite.com/pages/ajax-javascript/` | AJAX + selector readiness | 年份切换后的电影列表与选择年份一致 |

### HTTP、格式与失败语义

| ID | URL | 正确结果 |
| --- | --- | --- |
| `utf8-multiscript` | `https://httpbin.org/encoding/utf8` | UTF-8 多脚本文字无 replacement character |
| `gzip-json` | `https://httpbin.org/gzip` | 解压后合法 JSON 且 `gzipped=true` |
| `redirect-three` | `https://httpbin.org/redirect/3` | 保存完整 3-hop status chain，最终到 `/get` |
| `not-found` | `https://httpbin.org/status/404` | 明确 `failed/not_found`，不得返回 valid 空正文 |
| `delayed-response` | `https://httpbin.org/delay/2` | 超时预算两侧分别得到成功与 timeout，attempt 可解释 |
| `stream-jsonl` | `https://httpbin.org/stream/20` | 20 个 JSON records，断流 Case 不得提交残缺 artifact |

### 真实单页 Canary

| ID | URL | 类型与稳定锚点 |
| --- | --- | --- |
| `rfc-robots` | `https://www.rfc-editor.org/rfc/rfc9309.html` | 标准文档；标题、RFC 号、2.2/2.3 章节 |
| `rfc-http` | `https://www.rfc-editor.org/rfc/rfc9110.html` | 超长 HTML；HTTP Semantics 与固定章节 |
| `mdn-http-overview` | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview` | 文档正文、代码、站点导航去噪 |
| `node-fetch-doc` | `https://nodejs.org/api/globals.html#fetch` | 锚点定位、大文档、API signature |
| `python-urllib-doc` | `https://docs.python.org/3/library/urllib.request.html` | 文档层级、代码块、Python 版本信息 |
| `playwright-intro` | `https://playwright.dev/docs/intro` | Docusaurus 页面、安装命令、侧栏去噪 |
| `crawler-en` | `https://en.wikipedia.org/wiki/Web_crawler` | 英文、infobox、正文、引用链接 |
| `crawler-zh` | `https://zh.wikipedia.org/wiki/%E7%B6%B2%E8%B7%AF%E7%88%AC%E8%9F%B2` | 中文、跨语言 metadata、正文 |
| `wcxb-abstract` | `https://arxiv.org/abs/2605.21097` | 论文 metadata、摘要、作者、PDF link |
| `wcxb-pdf` | `https://arxiv.org/pdf/2605.21097` | `application/pdf`、页数、标题、摘要关键词 |
| `json-post` | `https://jsonplaceholder.typicode.com/posts/1` | JSON Schema、`id=1`、固定 user/title/body |
| `rss-frontpage` | `https://hnrss.org/frontpage` | XML/RSS、channel、item/link/pubDate 关系 |
| `jsonld-standard` | `https://www.w3.org/TR/json-ld11/` | 超长规范、TOC、代码块、章节结构 |
| `wikidata-entity` | `https://www.wikidata.org/wiki/Special:EntityData/Q42.json` | 大型多语言 JSON、entity `Q42` 与 claims |

这些 URL 不直接承担 WCXB 式全文 gold truth；它们承担 live freshness、真实站点漂移、格式和 Browser
路径探测。严格内容质量仍以固定 HTML/WARC + 人工 gold truth 为准，避免把网站改版误判成 crawler
回归。

## Case Manifest

建议规范源为 `benchmarks/cases/*.json`，Schema 为 `benchmarks/schema/case.schema.json`：

```json
{
  "id": "article-static-001",
  "layer": "fixture",
  "category": "article",
  "input": {
    "url": "http://controlled.test/article/001",
    "intent": "read",
    "freshnessSeconds": 0
  },
  "policy": {
    "browserAllowed": true,
    "authProfile": null,
    "maxAttempts": 2,
    "maxDurationMs": 10000,
    "maxBrowserMs": 3000
  },
  "truth": {
    "required": [
      { "type": "title_equals", "value": "Example Article" },
      { "type": "contains_text", "value": "ground truth paragraph" },
      { "type": "min_content_characters", "value": 1200 }
    ],
    "forbidden": [
      { "type": "contains_text", "value": "Sign in to continue" }
    ]
  },
  "reviewedAt": "2026-08-28T00:00:00Z",
  "expiresAt": null
}
```

Manifest 只描述输入、预算和真值，不指定必须使用 HTTP 或 Browser。否则 Benchmark 会测实现细节，
无法评估 Access Planner。

## Harness 边界

```text
Case Loader
  -> Isolated Run Coordinator
     -> Diaoyan public contract
        -> Result Collector
           -> Truth Evaluator
              -> Metrics Aggregator
                 -> JSONL + summary.json + human report
```

- Harness 只能通过公开 Reader/Crawl 合同调用系统，不得 import 私有函数制造虚假通过。
- Truth Evaluator 是独立消费者，不得使用生产 `validateContent` 作为唯一真值。
- 每个 Case 在独立数据目录运行，或显式声明共享缓存实验。
- 运行记录包含 Git SHA、Node/Chrome 版本、配置 Hash、Case Set Hash 和开始时间。
- 原始结果保存为有界 JSONL；HTML、Trace 和截图只在失败或抽样时保存。
- 授权页面、Cookie、Token 和正文敏感内容不得进入公共 Benchmark 工件。

## Benchmark 运行模式

| 模式 | 目的 | 默认网络 |
| --- | --- | --- |
| `pr` | 快速阻止确定性回归 | Layer A/B |
| `nightly` | 完整资源与恢复测试 | Layer A/B，少量 C |
| `release` | 发布候选对照 | 全部有效 Case |
| `competitor` | 同 URL、同预算外部对照 | Layer C，显式 API Key |
| `shadow` | 线上小样本比较规划路径 | 真实流量，严格采样和隐私边界 |

外部竞品对照必须记录套餐、地区、选项和时间；不能把一次测试外推成永久排名。

当前单 Case 运行入口：

```bash
# Clash/TUN Fake-IP 环境才需要显式设置第一个变量；默认安全策略保持关闭。
DIAOYAN_ALLOW_DNS_FAKE_IP=1 pnpm bench:case -- \
  --case benchmarks/cases/quotes-js-auto.json
```

当前小型 Corpus 聚合入口：

```bash
# Clash/TUN Fake-IP 环境才设置此前缀；其他环境直接运行 pnpm bench:corpus。
DIAOYAN_ALLOW_DNS_FAKE_IP=1 pnpm bench:corpus
```

该命令按 Case ID 稳定排序运行 `benchmarks/cases/*.json`，输出 gitignored 的
`corpus-latest.json` 与逐行原始记录 `corpus-latest.jsonl`。聚合器分别报告 Case 真值通过率、有效
Artifact 率、假成功、uncertain、Browser Uplift、Retry Recovery/Waste、有效延迟和资源向量形式的
Cost per Valid Artifact；没有部署单价时不虚构货币成本。

该 Case 通过生产 `ReaderService` 的 `auto` 路径，不 import 私有 extractor。报告同时保留外层 logical
retry、按 HTTP/Browser 拆分的 fetch 次数和响应字节，再交给独立 Truth Evaluator；非 `valid` 结果
以非零退出码结束。

## 防止 Benchmark 被优化作弊

- Case ID 和 URL 不得被生产 Planner 特判。
- Release 评测包含未公开的保留 Case。
- 断言以用户目标为中心，不以特定 HTML 选择器为中心。
- 单项提升若造成 False Success 或 Cost per Valid Artifact 恶化，不能宣称整体提升。
- Case 删除、降级或放宽断言必须单独 review，并在报告中保留前后影响。
- 测试失败必须修生产实现或真值错误，禁止只改期望值让结果变绿。

## 发布门槛

建立首个 baseline 后再填写具体数值。没有 baseline 前不承诺虚构 SLO。

每个 Release 至少满足：

- P0 Corpus 的 Valid Result Rate 不低于当前发布基线。
- False Success Rate 不得回归。
- Cost per Valid Artifact 的变化可解释。
- 每个新增 Provider/Adapter 至少有合同测试和一个失败 Case。
- 浏览器路径必须报告 Uplift，不能仅报告浏览器成功数。
- 恢复测试证明没有静默丢页和不可解释重复。

## 建议实现位置

| 边界 | 建议路径 | 禁止依赖 | 测试/验证 |
| --- | --- | --- | --- |
| Case Schema | `benchmarks/schema/` | 生产数据库 | Schema fixture validation |
| Case Loader | `benchmarks/harness/cases.ts` | Provider 私有实现 | malformed/expired Case tests |
| Truth Evaluator | `benchmarks/harness/evaluate.ts` | `src/validation.ts` 作为真值 | assertion matrix tests |
| Run Coordinator | `benchmarks/harness/run.ts` | 直接调用私有 extractor | controlled-site integration |
| Cost Aggregator | `benchmarks/harness/cost.ts` | 硬编码商业价格 | deterministic aggregation tests |
| Controlled Site | `benchmarks/controlled-site/` | 外部网络 | fault-sequence E2E |
| Reports | `benchmarks/reports/`，默认 gitignored | 凭证、Cookie、敏感正文 | redaction tests |

Readiness 真值合同和 Tournament 已从临时聚合文件拆到 `benchmarks/readiness/contract.ts` 与
`benchmarks/readiness/tournament.ts`；通用 Case/Truth 合同继续由 `benchmarks/harness/contract.ts`
负责，受控 HTTP graph runner 保留在 `benchmarks/controlled-site/server.ts`。

## P0/P1/P2

| 优先级 | 工作 | 完成条件 | 验证 |
| --- | --- | --- | --- |
| P0 | Case Schema、Layer A、Truth Evaluator、JSONL 报告 | 文章、Shell、gate、JSON、429、超时 Case 可确定运行 | `pnpm test -- tests/reliability-benchmark.test.ts` |
| P0 | Controlled Site 和成本采集 | 能证明请求次数、等待、浏览器时间和恢复结果 | `pnpm test -- tests/reliability-controlled-site.test.ts` |
| P1 | Layer C Canary 与 Case 过期机制 | 网站漂移不会伪装产品回归 | `pnpm bench --mode nightly` |
| P1 | Release 对照和趋势报告 | 同 Case Set 可比较两个 Git SHA | `pnpm bench --mode release --compare <baseline>` |
| P2 | 竞品与 Shadow 模式 | 外部配置可复现，敏感信息不入工件 | `pnpm bench --mode competitor`; redaction tests |

## 非目标

- 不证明“任何网站都能抓”。
- 不以绕过访问控制、验证码、付费墙或 robots 作为成功。
- 不在 P0 用 LLM 充当全部真值。
- 不把压测吞吐等同于内容正确性。
- 不为 Benchmark 新建一套与生产无关的抓取实现。

## 开放问题

- 首批付费场景优先文章/文档，还是结构化列表/监控？这决定 Corpus 权重。
- PDF 与授权页面是否进入首个 P0，或作为 P1 独立能力包？
- Live Canary 的人工复核周期由谁负责？
- 外部竞品对照的预算上限和运行频率是多少？

## Readiness

本规范已经足够执行 P0 Benchmark。2026-08-28 已落地版本化 runner result 合同、严格 stdout 解析、
Case Schema、live 过期与策略矛盾检查、独立 Truth Evaluator、Reader artifact adapter、deterministic
word-F1、确定性 4 叉 crawl graph、Run Coordinator、macOS wall/CPU/RSS，以及 Undici、Crawlee、
Scrapy、Colly 四个 HTTP runner。相关 29 个 focused tests 已覆盖 HTTP harness 与 Case truth contract。

首轮受控 HTTP baseline 见 [crawler-architecture-landscape.md](./crawler-architecture-landscape.md)。首个
`quotes-js-auto` live Browser Case 也已通过：HTTP shell 被明确判为 `INCOMPLETE_CONTENT`，随后 Browser
得到 1,064 字符有效正文；同一 logical attempt 内记录 `http=1`、`browser=1`，响应字节分别为 5,808
和 8,985，独立裁判全部断言通过。Browser 候选现在必须携带 readiness provenance；最终验证样本记录
`waitedMs=327`、`reason=meaningful-content-stable`、可见正文 1,499 字符。另三次公网重复运行全部 valid，
总耗时分别为 6.14s、7.62s、9.39s；总耗时包含 HTTP 探测、Browser 启动和公网导航，不能归因给
327ms readiness。该小样本只能证明 Browser uplift 与证据链已接通，不能代表 Browser group。

受控 Readiness Tournament 使用即时正文、900ms 延迟正文、Skeleton、持续变化正文、无限滚动五类
真实 DOM 页面，对 fixed-750、adaptive、target 三策略各重复 5 次。75 次运行中：fixed-750 有效率
40%、假成功率 60%；adaptive 有效率 60%、假成功率 20%；target 有效率 100%、假成功率 0%。对应
valid latency median/p95 的实现验收复跑为 765/769ms、1,251/1,556ms、553/1,248ms。结果保存在 gitignored 的
`benchmarks/reports/readiness-latest.json`，复现命令为 `pnpm bench:readiness -- --repeats 5`。

该结果只决定 ReadinessPolicy 的受控架构优先级：目标/终态条件优先，正文稳定作为 Generic fallback，
scroll/click 必须显式预算化；它不代表真实互联网类别分布，也不构成竞品排名。

生产首版现已把 CSS 目标条件和有界 `scroll-to-end` 接入 `ReadPageOptions`、MCP 输入、Reader 与
`PageFetcher` adapter 合同；显式目标在 `auto` 模式直接选择 Browser，策略进入 Cache key，结果返回
policy、reason、匹配数和交互步数。Tournament 的 target 策略复用同一生产 readiness runtime。

2026-08-29 的 Public URL v1 小型基线包含 6 个 Case：动态 Browser、静态列表、登录 gate、RFC 长文档、
404 失败语义和 500 retry-waste。6/6 真值通过，5 个 eligible Case 中产出 3 个有效 Artifact，假成功为
0；唯一 Browser 启动由 HTTP shell 升级后恢复，首个重试 Case 产生 1 次无效重试和 500ms 等待。单位
有效 Artifact 的最终验收资源向量为 2.33 个 HTTP 请求、36,701 bytes、1,875 Browser ms、0.33 个
Browser Context、0.33 次 retry、167ms retry delay 和 6,509ms 端到端时间。该样本含两个故意失败 Case，60%
Valid Result Rate 不能外推为产品 SLO；它只证明聚合和证据链可复现。

Layer A gold truth、完整故障注入、公开站点 selector/无限滚动 canary、Release 趋势、环境/配置指纹和
闭源 Provider 对照仍未完成，因此不能声称完整 Benchmark 已完成，也不能声称 Diaoyan 已达到生产级
可靠性或优于任何竞品。
