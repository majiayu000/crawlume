# 竞品与市场格局（2026-08-25）

## 调研边界

本文件基于竞品官方产品页、文档、定价页和开源仓库进行桌面调研。它用于确定产品方向，不能替代购买账号后的同 URL 基准测试。定价和能力会变化，采购前必须重新核对官方页面。

## Agent 网页上下文 API

| 产品 | 核心能力 | 商业信号 | 对 Diaoyan 的含义 |
|---|---|---|---|
| [Firecrawl](https://www.firecrawl.dev/pricing) | Scrape、Crawl、Map、Search、Monitor、Interact | 免费 1,000 credits/月，按页计费 | 通用 LLM 网页读取已经成熟，不能只复制 API 表面 |
| [Tavily](https://www.tavily.com/pricing) | Search、Extract、Crawl、Map、Research | 免费 1,000 credits/月，按请求/深度计费 | 搜索与研究已向一体化发展 |
| [Exa](https://exa.sh/pricing?tab=api) | 语义搜索、Contents、Research、Websets | Contents 低价，Research 单独计费 | 已知 URL 的纯内容读取接近基础商品 |
| [Parallel](https://parallel.ai/pricing) | Search、Extract、Responses、Monitor、Find All | Extract 公布价约 $1/1,000 次 | 纯 Extract 很难建立高毛利 |
| [Jina Reader](https://jina.ai/reader/) | URL 转 LLM 友好文本、Search | 无 Key 也提供有限免费速率 | 免费读取体验构成直接替代 |
| [ScrapeGraphAI](https://scrapegraphai.com/) | Scrape、Extract、Search、Crawl、Monitor | 免费试用，订阅从个人到企业 | LLM 结构化提取也已拥挤 |

## 浏览器基础设施

| 产品 | 核心能力 | 对 Diaoyan 的含义 |
|---|---|---|
| [Browserless](https://www.browserless.io/pricing) | 托管浏览器、Session、代理、验证码、MCP、自托管 | 单卖浏览器池没有明显空位 |
| [Browserbase](https://www.browserbase.com/pricing) | Browser Session、Agent Runtime、Identity、代理、Fetch | Agent 浏览器、身份与读取正在融合 |
| [Steel](https://steel.dev/) | 开源 Headless Browser API、云端浏览器 | 自托管浏览器 API 也有成熟替代 |
| Playwright | 本地真实浏览器、完整交互 | Diaoyan 本地版可继续以它作为免费执行面 |

## 抓取、代理与解封 API

| 产品 | 核心能力 | 对 Diaoyan 的含义 |
|---|---|---|
| [Bright Data Web Unlocker](https://brightdata.com/pricing/web-unlocker) | IP、TLS、浏览器指纹、验证码、结果验证 | 不应与大型代理网络正面竞争 |
| [Zyte API](https://www.zyte.com/pricing/) | HTTP、浏览器、Session、自动提取、分级站点定价 | 高难站点读取具有真实且可变的边际成本 |
| [ScrapingBee](https://www.scrapingbee.com/pricing/) | Headless Browser、代理、地理位置、提取规则 | 中小团队也能低门槛购买抓取 API |
| [Apify](https://apify.com/pricing) | Actor 市场、任务运行、代理、存储、调度 | 站点专用适配器和市场模式已经被验证 |

## 开源与自托管

| 产品 | 核心能力 | 对 Diaoyan 的含义 |
|---|---|---|
| [Firecrawl](https://github.com/firecrawl/firecrawl) | 完整 API、Worker、队列、Playwright、自托管 | 功能全面但基础设施较重 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Markdown、过滤、引用、结构化提取、浏览器 | 免费本地路线已有强竞争者 |
| Scrapy / Crawlee | 成熟的可编程爬虫框架 | Diaoyan 不应重新发明通用爬虫框架 |

## 合规授权、身份与内容交易

| 产品/标准 | 所在位置 | 能力 |
|---|---|---|
| [Cloudflare AI Crawl Control](https://developers.cloudflare.com/ai-crawl-control/) | 网站边缘 | 识别、允许、阻止、robots 管理、Pay Per Crawl |
| [Cloudflare Verified Bots](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/) | Agent 身份 | Web Bot Auth、稳定 IP/UA、反向 DNS、行为要求 |
| [TollBit](https://docs.tollbit.com/docs/introduction) | 出版商与 AI 买方之间 | Agent Site、许可、按页定价、交易和审计 |
| [RSL](https://rslstandard.org/guide/web-crawlers) | 开放标准 | 机器可读许可、License Token、Crawler Authorization Protocol |
| [Apify Agentic Payments](https://docs.apify.com/actors/publishing/monetize) | 工具市场 | Agent 发现、调用并按事件支付 Actor |

## 竞争结论

以下方向没有足够差异化：

- 更便宜的 Firecrawl。
- 又一个 URL 转 Markdown 服务。
- 又一个托管 Chrome API。
- 住宅代理或解封 API 转售。
- 从出版商侧复制 TollBit 或 Cloudflare。

相对可行的空位是需求侧的 Agent Web Gateway：

1. 本地优先，用户 Cookie 和登录态默认不离开设备。
2. 在 HTTP、真实浏览器、官方 API、RSS 和许可内容之间做策略路由。
3. 失败透明，不能把应用壳、挑战页、登录墙或错误内容包装为成功。
4. 每次返回来源、内容哈希、读取方式、许可判断和成本证据。
5. 同时提供 CLI、MCP、API 和企业私有部署。
6. 后续兼容 Web Bot Auth、RSL、TollBit 和 Cloudflare 的许可路径。

## 尚未完成的验证

正式进入云服务开发前，应使用统一的公开测试集，对至少以下产品做实测：Firecrawl、Tavily、Jina Reader、Parallel、Browserbase、Browserless、Bright Data、Zyte、ScrapingBee。指标包括成功率、延迟、正文质量、错误透明度、缓存行为、许可行为和每次成功结果成本。
