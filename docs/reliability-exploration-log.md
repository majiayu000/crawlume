# Diaoyan Reliability Exploration Log

用途：记录围绕“用更少成本获得更多可信结果”的研究、决策、假设、实验和否证。
规范源：架构合同以 [reliability-architecture.md](./reliability-architecture.md) 为准；真值与指标以
[reliability-benchmark-spec.md](./reliability-benchmark-spec.md) 为准。
本文件是 append-oriented 研究日志，不替代已实现状态文档 `spec.md`。

## 记录规则

每次重要探索追加一条记录，包含：

- 日期、问题和背景。
- 当前假设与为什么值得验证。
- 支持/反对证据。
- 决定、未决定项和否证条件。
- 对应 Benchmark Case、实现任务或文档链接。

聊天结论不得只复制为长段文字；应收敛成 Decision、Hypothesis 或 Experiment。外部网页和竞品能力
会变化，记录来源与核对日期，不把旧调研当当前事实。Notion 等外部页面可以作为阅读镜像，但在明确
指定页面与同步责任前，版本库内文档是规范源。

## 2026-08-27 至 2026-08-28：产品核心收敛

### Context

最初问题是 Diaoyan 是否应成为“任何网站都能访问、非常无痕”的强爬虫，以及本地凭证和浏览器是否
有实际价值。后续讨论逐步把目标从不可验证的“万能访问”收敛为可测量的可靠网页读取服务。

### Findings

1. 浏览器是必要执行器，但不是完整爬虫系统。成熟系统还需要发现、Frontier、抽取、验证、恢复、
   资源治理和结果合同。
2. 本地凭证能够复用用户已有授权，不能创造用户原本没有的权限。它适用于明确授权的登录页面，
   不解决 API 权限、付费、验证码或账号风控。
3. X 等复杂平台应优先使用官方 API；网页可见但 API 不覆盖的小规模授权任务可使用用户已有浏览器；
   登录、2FA、人工验证和写操作必须进入人工 checkpoint。
4. Firecrawl、Crawlee/Scrapy、Browserbase/Browserless、Crawl4AI 分别证明了 Web Data API、调度框架、
   浏览器基础设施和本地抽取库的市场，但没有证据证明 browser-first 可以替代其他层。
5. “企业级”被澄清为有人愿意付费的产品质量，不等同于多租户、SSO 或面向大企业销售。
6. 用户付费购买的是持续稳定的 Web-to-Data 结果，以及免除浏览器、队列、抽取和站点改版维护成本。
7. 单个功能容易复制；长期能力来自真值 Corpus、失败数据、Adapter、策略评测、单位成本和修复速度。

### Decisions

#### D-001：产品总目标

优化 `Cost per Valid Artifact`，而不是原始调用成功率或页面吞吐。

原因：成功率、成本、延迟会互相影响，只有经过独立真值验证的有效结果能代表用户价值。

#### D-002：Fail-visible 是不可退让的产品合同

登录页、挑战页、空壳、残缺结果和不满足 Schema 的内容不得返回为完整成功。`uncertain` 必须与
`valid` 分开统计。

#### D-003：HTTP-first、Browser-capable、Adapter-driven

Browser 只在渲染、交互或授权 Session 确有必要时升级。Feed、Sitemap、JSON-LD、PDF、官方 API 和
站点 Adapter 是同级能力，不是浏览器之后的装饰功能。

#### D-004：Benchmark 先于“智能优化”

没有独立真值时，任何 Planner、重试、并发或内容评分优化都无法证明提升。生产 Validator 不得同时
充当 Benchmark Truth Evaluator。

#### D-005：多租户不是可靠性核心

Hosted API 将来需要最小 API Key、计量和隔离，但组织、SSO、RBAC、账单和复杂控制台不进入当前
P0/P1。交付外壳不能挤占爬虫能力建设。

#### D-006：不以规避提升能力

不通过验证码处理、访问控制规避、付费墙绕过、身份伪装或在 429 后轮换身份来提高成功率。策略停止
是可信结果的一种，不是需要隐藏的失败。

#### D-007：版本库文档为规范源

本轮形成的 Benchmark、架构、假设和路线图记录在 `docs/`。若未来同步到 Notion，Notion 默认是
阅读镜像，必须另行指定页面、同步方向和 owner 才能改变规范源。

## Current Hypotheses

| ID | Hypothesis | Primary metric | Guardrail | Falsified when |
| --- | --- | --- | --- | --- |
| H-001 | 先 HTTP 再按验证结果升级 Browser 能降低单位有效成本 | Cost/Valid | Valid Rate、p95 | 成本无改善且 Valid Rate 显著下降 |
| H-002 | 基于正文稳定/目标条件的 readiness 优于固定 750ms | Valid Latency、False Success | Browser timeout | 在代表性动态 Case 上无显著改善 |
| H-003 | Stage-level retry 比 operation retry 更省成本 | Retry Waste | Recovery Rate | 请求数下降但有效恢复也同步恶化 |
| H-004 | 同 raw response 多 Extractor 可减少重复 Fetch | HTTP requests/Valid | Valid Rate | 大多数失败来自访问而非抽取 |
| H-005 | 按 origin 自适应并发能提高总吞吐且减少 429 | Valid pages/min | 429、p95、内存 | 总吞吐不升或错误/资源显著恶化 |
| H-006 | 确定性 Adapter 在高频页面上优于通用抽取/LLM | Cost/Valid、Schema Valid | 维护小时 | 页面变化导致维护成本超过收益 |
| H-007 | 少量 uncertain 样本使用可选模型具有正 ROI | Uncertain->Valid uplift | token cost、False Success | 成本增加高于有效结果增量 |
| H-008 | 条件缓存和 singleflight 显著降低重复流量 | bytes/Valid、requests/Valid | Freshness | 节省有限或陈旧错误增加 |

## Experiment Backlog

### E-001：HTTP/Browser Shadow

- 假设：H-001。
- 设计：对受控和授权的 1%～5% 样本同时运行 HTTP、Browser；只把正常 Planner 结果返回给调用方。
- 主要指标：Browser Uplift、Cost/Valid。
- 护栏：False Success、Browser p95、预算超限。
- 停止条件：达到预设 Browser 预算或样本不再代表真实类别。
- 工件：按 Case 类别聚合，不记录 Cookie、Token 或敏感正文。

### E-002：Readiness Tournament

- 假设：H-002。
- 变体：固定 750ms、正文稳定、目标 selector、Adapter policy。
- Case：即时正文、延迟正文、持续网络、Skeleton、永不稳定页面。
- 决策：按 Valid Latency 和 False Success 的 Pareto 前沿选择默认策略。

### E-003：Retry Counterfactual

- 假设：H-003。
- 设计：记录每次 Stage 首次结果与最终结果，离线计算不重试、一次重试和当前策略的差异。
- 禁止：为了实验增加真实站点请求；优先用历史 Attempt Ledger 和 Controlled Site。

### E-004：Extractor Tournament

- 假设：H-004/H-006。
- 变体：Readability、Clean Document、JSON-LD、Feed、PDF、Site Adapter、可选模型。
- 真值：独立断言和人工抽样，不使用生产 Validator 自证。
- 输出：每页面类别的 Valid Rate、False Success、CPU、token 和维护成本。

### E-005：Concurrency Sweep

- 假设：H-005。
- 设计：HTTP/Browser 分池，逐级提高全局与每 origin 并发；注入 429、延迟和内存压力。
- 主要指标：Valid pages/min、Cost/Valid。
- 护栏：p95、429、Browser crash、peak RSS、恢复重复率。

### E-006：Cache Revalidation

- 假设：H-008。
- 变体：full fetch、TTL、ETag/Last-Modified、stale-while-revalidate、singleflight。
- 护栏：Freshness assertion 和授权内容隔离。

### E-007：Adapter ROI Gate

- 输入：某页面类别近 30 天的 eligible volume、Valid Rate、失败成本和潜在付费价值。
- 建 Adapter 条件：通用路径无法达到目标，且预计节省超过持续维护成本。
- 退役条件：官方 API/结构化源出现，或 Adapter 长期使用量和收益不足。

## Claims Requiring Evidence

以下说法目前都不能写入产品宣传：

- “世界上最强的爬虫”。
- “任何网站都能抓”。
- “比 Firecrawl/AnyCrawl 成功率更高”。
- “生产级”或“企业级可靠性”。
- “Browser fallback 一定提高成功率”。
- “并发越高单位成本越低”。

只有版本化 Benchmark、当前代码 SHA、Case Set Hash 和可复现实验支持时才能作限定范围的声明。

## Evidence Reviewed

### Repository

- `README.md`：当前产品表面和 fail-visible 合同。
- `src/reader.ts`：HTTP→Browser 回退和缓存主链。
- `src/fetch/browser.ts`：BrowserContext、固定等待和浏览器池接入。
- `src/extract.ts`、`src/validation.ts`：抽取和现有低成本校验。
- `src/crawl-policy.ts`：operation 粒度重试和 origin 间隔。
- `src/site.ts`：串行内存 Frontier。
- `src/jobs.ts`：Job 持久化和恢复。
- `src/cache.ts`、`src/metrics.ts`：TTL Cache 和运行聚合。

### External primary sources

- [Scrapy Architecture](https://docs.scrapy.org/en/master/topics/architecture.html)
- [Scrapy AutoThrottle](https://docs.scrapy.org/en/master/topics/autothrottle.html)
- [Crawlee Introduction](https://crawlee.dev/js/docs/introduction)
- [Crawlee Request Managers](https://crawlee.dev/js/docs/next/guides/request-loaders)
- [Playwright Auto-waiting](https://playwright.dev/docs/actionability)
- [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)
- [Crawl4AI Multi-URL Crawling](https://docs.crawl4ai.com/advanced/multi-url-crawling/)
- [Firecrawl Crawl](https://docs.firecrawl.dev/features/crawl)
- [Firecrawl Browser](https://docs.firecrawl.dev/features/browser)
- [Browserbase Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- [X Search](https://docs.x.com/x-api/posts/search/introduction)
- [X Timelines](https://docs.x.com/x-api/posts/timelines/introduction)

## Next Log Entry

P0 开始前补充：

- 首批付费场景和 Corpus 类别权重。
- 第一个 Case Manifest review。
- Baseline 运行配置和预算。
- 每个 P0 任务的 owner、PR 和验证结果。
