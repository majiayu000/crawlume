# Crawlume Reliability Benchmark 规范

状态：Implemented for controlled PR、public Nightly、paired Release compare and offline optimization；缺私有 Release/生产 rollout 证据
最后更新：2026-08-30

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
  httpProviderAttempts
  documentBytesIn
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

## 公开标准依据与 Crawlume 加严项

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

Crawlume 标准不是再造一个平均分，而是把这些互补条件串成一条不可绕过的真值链：

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

## Crawlume Web Retrieval Standard v1

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

Crawlume strict split 的开发集、公开 canary 和私有 set，其 registrable domain 不得与 strict
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

规范源为 `benchmarks/cases/*.json`，可执行 Schema 为
`benchmarks/harness/contract.ts` 导出的 `benchmarkCaseSchema`：

```json
{
  "schemaVersion": 2,
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
    "maxDocumentBytes": 2000000,
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

失败语义 Case 必须同时断言 `outcome_equals` 和 `error_code_equals`。只断言“失败”会把 SSRF、DNS、
Harness 配置错误等错误原因误判为正确行为。

## Harness 边界

```text
Case Loader
  -> Isolated Run Coordinator
     -> Crawlume public contract
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

当前统一入口只实现上述三种模式。外部竞品对照仍需另行批准预算与数据边界；Optimization Loop 的
Shadow 仅由 `pnpm bench:optimize` 在匿名受控 Case 离线运行，不是生产流量采样。

当前单 Case 运行入口：

```bash
# Clash/TUN Fake-IP 环境才需要显式设置第一个变量；默认安全策略保持关闭。
CRAWLUME_ALLOW_DNS_FAKE_IP=1 pnpm bench:case -- \
  --case benchmarks/cases/quotes-js-auto.json
```

统一 Corpus 入口：

```bash
# PR：46 个受控 Case，每个至少 5 次。
pnpm bench -- --mode pr

# Nightly：受控 Case + 10 个未过期公开 Canary，每个至少 5 次。
# Clash/TUN Fake-IP 环境才设置此前缀；其他环境直接运行。
CRAWLUME_ALLOW_DNS_FAKE_IP=1 pnpm bench -- --mode nightly

# Release：每个 Case 至少 30 次，并只接受完全相同 Case Set/repeat keys 的基线。
CRAWLUME_ALLOW_DNS_FAKE_IP=1 pnpm bench -- \
  --mode release --compare benchmarks/reports/release-baseline.json
```

命令按 Case ID、repeat 稳定排序，每次使用独立数据目录，并输出 gitignored 的
`<mode>-latest.json`、`<mode>-latest.jsonl` 与 `<mode>-gate.json`。报告携带 Case Set
version/hash、Git SHA、Node/Chrome/OS、脱敏配置 Hash 和 repeat。聚合器分别报告 Case 真值通过率、有效
Artifact 率、假成功、uncertain、Browser Uplift、Retry Recovery/Waste、有效延迟和资源向量形式的
Cost per Valid Artifact；没有部署单价时不虚构货币成本。

Release comparison 输出配对 outcome、有效率与 Cost per Valid 变化，以及 latency delta 的
median/p95/max 和确定性 95% bootstrap CI。当前仓库只有 10 个公开 Canary，没有私有 30-Case、
授权 WCXB/CleanEval 副本或生产 rollout 证据，因此机器 Gate 可以达到 `canary-ready`，但不得标成
`release-candidate` 或 `production-proven`。

每个 Case 通过生产 `ReaderService` 的共享 ReadIntent/Plan 路径，不 import 私有 extractor。报告同时保留外层 logical
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

受控与公开 baseline 已建立；第 203 节的门槛保持不变。没有私有 Release Corpus 和生产 rollout 前，
不填写或承诺生产 SLO。

每个 Release 至少满足：

- P0 Corpus 的 Valid Result Rate 不低于当前发布基线。
- False Success Rate 不得回归。
- Cost per Valid Artifact 的变化可解释。
- 每个新增 Provider/Adapter 至少有合同测试和一个失败 Case。
- 浏览器路径必须报告 Uplift，不能仅报告浏览器成功数。
- 恢复测试证明没有静默丢页和不可解释重复。

## 实现位置

| 边界 | 建议路径 | 禁止依赖 | 测试/验证 |
| --- | --- | --- | --- |
| Case Schema/Loader | `benchmarks/harness/contract.ts`、`corpus.ts` | 生产数据库 | malformed/expired Case tests |
| Truth/Cost/Gate | `benchmarks/harness/corpus.ts`、`metrics.ts`、`gates.ts` | `src/validation.ts` 作为真值；硬编码商业价格 | assertion/aggregation tests |
| Run Coordinator | `benchmarks/harness/suite.ts` | 直接调用私有 extractor | public Reader controlled-site integration |
| Controlled Site | `benchmarks/controlled-site/` | 外部网络 | fault-sequence E2E |
| Reports | `benchmarks/reports/`，默认 gitignored | 凭证、Cookie、敏感正文 | redaction tests |

Readiness 真值合同和 Tournament 已从临时聚合文件拆到 `benchmarks/readiness/contract.ts` 与
`benchmarks/readiness/tournament.ts`；通用 Case/Truth 合同继续由 `benchmarks/harness/contract.ts`
负责，受控 HTTP graph runner 保留在 `benchmarks/controlled-site/server.ts`。

## P0/P1/P2

| 优先级 | 工作 | 完成条件 | 验证 |
| --- | --- | --- | --- |
| P0 | Case Schema、Layer A/B、Truth、JSONL 报告（完成） | 46 个受控 Case×5 稳定运行 | `pnpm bench -- --mode pr` |
| P0 | 成本、Plan/Ledger provenance 与 Gate（完成） | 请求、等待、Browser、资源与终态可复算 | `pnpm test -- tests/benchmark-suite.test.ts tests/benchmark-corpus.test.ts` |
| P1 | Layer C Canary 与过期机制（完成） | 10 个未过期公开 Canary×5 | `CRAWLUME_ALLOW_DNS_FAKE_IP=1 pnpm bench -- --mode nightly` |
| P1 | Release 配对比较（完成合同） | 完全相同 Case Set/repeat keys 才可比较 | `pnpm bench -- --mode release --compare <baseline>` |
| P2 | 离线 Optimization Loop（完成） | 受控 Shadow/A-B/Counterfactual/Tournament；无敏感工件 | `pnpm bench:optimize` |
| 条件式 | 私有 Release、竞品和生产 rollout | 外部数据、预算与审核齐备 | 尚未触发，不伪造证据 |

## 非目标

- 不证明“任何网站都能抓”。
- 不以绕过访问控制、验证码、付费墙或 robots 作为成功。
- 不在 P0 用 LLM 充当全部真值。
- 不把压测吞吐等同于内容正确性。
- 不为 Benchmark 新建一套与生产无关的抓取实现。

## 尚需外部决策

- 私有 Release Corpus 的类别权重、保留 Case 和审核 owner。
- 生产 rollout 的流量、SLO、回滚窗口和数据留存边界。
- 外部竞品对照的预算、地区、套餐和凭证边界。

## Current Acceptance Evidence

- PR：46 个受控 Case×5，共 230 次；Truth 230/230，0 false success、0 harness error。
- Nightly：46 个受控 Case + 10 个未过期公开 Canary，各 5 次，共 280 次；Truth 280/280，0 false
  success、0 harness error。Clash/TUN Fake-IP 环境必须显式开启安全兼容变量，Harness 不自动放宽 SSRF。
- Readiness：5 个真实 DOM 类别×3 策略×5；target 25/25 valid、0 false success。
- Optimization：15 组受控 HTTP/Browser Shadow 中主路径有效 10、Browser 有效 15；Retry
  Counterfactual 记录 15 次恢复和 10 次浪费；Extractor Tournament 复用同一 rawRef。
- 每个报告携带 Case Set version/hash、Git SHA、Node/Chrome/OS、脱敏配置 Hash、repeat 和可复算
  Plan/Ledger provenance；过期 Canary 在网络调用前成为 `harness_error`。
- Release compare 合同已经实现，但仓库没有私有 30-Case baseline、授权 WCXB/CleanEval 副本或生产
  rollout。机器 Gate 因此准确停在 `canary-ready`，不得标为 `release-candidate`、
  `production-proven` 或竞品领先。
