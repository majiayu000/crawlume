# Diaoyan Crawler v0.9.1

## 目标

为本地 Agent 提供长期可运行、失败可诊断的网页读取能力。服务通过 MCP stdio 暴露工具，优先读取公开静态页面，只在页面需要 JavaScript 渲染时使用真实 Chromium。需要登录的页面使用用户手动建立的专用浏览器 Profile。

v1 不伪装第三方 AI 爬虫，不自动破解 CAPTCHA，不绕过登录、付费或站点访问控制。

## 对外工具

### `search_web`

搜索本地 SQLite 全文索引、管理员配置的 SearXNG JSON API，或组合两者，返回标准化的标题、URL、摘要、来源、日期和 Provider 分数。

- `query`：必填，最多 512 字符。
- `limit`：默认 10，最大 20。
- `page`：默认 1，最大 100。
- `language`：默认 `all`。
- `safeSearch`：`0`、`1` 或 `2`，默认 1。
- `timeRange`：可选的 `day`、`month` 或 `year`。
- `source`：`auto`、`local` 或 `web`，默认 `auto`。

仅当管理员显式设置 `DIAOYAN_LOCAL_INDEX_ENABLED=1` 时，成功公开读取才写入本地 FTS5；
爬虫默认不建设记忆索引，授权 Profile 页面始终不得索引。启用后，`auto` 第 1 页本地优先，并由
SearXNG 补足和按 URL 去重；后续页使用外部 Provider。外部补足失败但已有本地命中时必须返回
`partial` 和 warning。没有本地语料且未配置 Provider 时必须返回
`SEARCH_PROVIDER_NOT_CONFIGURED`。实例禁用 JSON、返回错误状态或响应结构异常时必须返回
`SEARCH_PROVIDER_ERROR`，不得伪造空成功结果。

### `read_page`

输入：

- `url`: 必填，`http` 或 `https` URL。
- `mode`: `auto`、`http` 或 `browser`，默认 `auto`。
- `cacheMode`: `prefer-cache`、`live` 或 `cache-only`，默认 `prefer-cache`。
- `maxAgeSeconds`: 可接受的缓存年龄，默认 900 秒。
- `authProfile`: 可选的专用浏览器 Profile 名称。
- `browserReadiness`: 可选的显式浏览器终态策略。必须包含 1–512 字符的 CSS `target.selector`；
  可指定 `attached|visible`、最小匹配数、100–120000ms 超时，以及最多 100 步的有界
  `scroll-to-end` 交互。显式 HTTP 模式不接受该参数。

成功返回：

- 原始 URL、最终 URL、抓取时间和读取方式。
- 标题、作者、发布时间、Markdown 正文。
- HTTP 状态、Content-Type、响应字节数、正文字符数和 SHA-256。
- 提取方法和缓存命中状态。
- `validation.status`：`usable` 或 `uncertain`。
- `validation.warnings`：稳定 warning code 与可读说明。
- Browser 结果包含 `browserReadiness.policy/reason/waitedMs`；目标策略额外返回匹配数、交互类型和
  已执行步数。

失败返回 MCP `isError: true`，正文为结构化错误 JSON。

### `inspect_page`

执行与 `read_page` 相同的读取和校验，但不返回正文，只返回诊断证据。

### `map_site`

从一个公开 URL 开始，串行发现同主机链接。默认最多扫描 50 页、深度 2，并移除查询参数和锚点后去重。可显式允许子域或保留查询参数，最多 500 页、深度 10。

成功返回已扫描 URL、发现来源、深度、截断状态和逐页失败。起始页失败时整个调用失败；后续页面失败时返回 `partial`，不得静默丢弃。

### `crawl_site`

使用与 `read_page` 相同的读取、缓存、完整性和授权规则，边发现边读取同主机页面。默认最多 10 页、深度 2，硬上限 50 页。每页返回 Markdown、证据、发现来源和深度。

起始页失败时整个调用失败；后续页面失败时返回 `partial` 与逐页结构化错误。

### 异步 Crawl Job

- `start_crawl`：立即返回 UUID；支持 1–32 并发、最高 10,000 页和 Crawl 累计硬预算。
- `get_crawl`：返回 `queued`、`running`、`paused`、`completed`、`failed` 或 `cancelled`，以及页级 progress、累计 usage、预算和错误。
- `get_crawl_pages`：按不可变 publication sequence 分页读取页面终态，cursor 可安全重放。
- `pause_crawl` / `resume_crawl`：暂停领取新页面或从 SQLite Frontier 继续。
- `cancel_crawl`：中断活动请求，并把未领取页面发布为明确的 `stopped` 终态。

任务、页面 Frontier、origin 调度槽、资源 reservation 和 publication 保存在 `cache.sqlite`。
Worker 使用 lease heartbeat 与 owner/generation fencing；进程中断后只回收过期 lease，已提交页面
不重抓。累计预算耗尽使 Job `failed/BUDGET_EXHAUSTED`，未领取页面变为 `stopped`，不得伪装为成功。
普通 CLI 进程不得恢复或执行后台队列；每个数据目录只允许一个主动 Worker 服务进程。

### `get_crawler_stats`

返回最近 1-90 个 UTC 自然日的内容读取聚合，默认 7 日。包括请求、成功、失败、成功率、缓存
命中、实时读取方式、响应字节、正文字符、读取尝试、重试等待、墙钟耗时、失败错误码和逐日数据。

统计不保存 URL、hostname、标题、正文、搜索词、代理地址或授权 Profile。缓存命中的响应字节、
尝试和重试等待按 0 计，避免重复计算已经发生过的上游成本；无请求时成功率和缓存命中率返回
`null`。

### 页面变化 Monitor

- `start_monitor`：持久化单 URL、读取模式、可选授权 Profile 和 60-604800 秒间隔，立即调度。
- `get_monitor`：返回状态、下次运行、成功基线 Hash、计数和最后运行。
- `list_monitors`：返回最近创建的监控，默认 20、最大 100。
- `cancel_monitor`：永久停止监控；运行中任务收到协作式取消信号。

每次 Monitor 强制实时读取。第一次成功建立基线并返回 `changed=null`，后续相同 Hash 返回
`false`，不同 Hash 返回 `true` 并更新 `lastChangedAt`。失败写入结构化 `lastRun`，不清空成功
基线，也不停止下一周期调度。

### `list_auth_profiles`

列出本地专用浏览器 Profile。不得返回 Cookie、令牌或 Profile 内文件。

## 读取策略

`auto` 首先执行 HTTP 读取：

1. 401、402、403、429 和 5xx 必须原样失败，不切换 UA，不静默换提供商。
2. HTTP 200 但检测为 JavaScript 壳或正文不完整时，允许切换到真实浏览器渲染。
3. 浏览器渲染后仍不完整时返回明确错误。
4. 指定 `authProfile` 时直接使用浏览器路径。
5. 指定 `browserReadiness` 时，`auto` 直接使用浏览器并等待明确终态；不得先返回绕过 DOM 条件的
   HTTP 正文。

`http` 和 `browser` 只使用指定路径，不自动切换。

Browser 默认使用正文指纹稳定窗口作为通用兜底。显式目标策略以 CSS selector 的 attached/visible
状态和最小匹配数作为成功条件；`scroll-to-end` 只能在声明最大步数和单步等待后执行。目标在总超时
或交互步数耗尽前未满足时返回 retryable 的 `FETCH_TIMEOUT`，不得把首屏或部分列表包装成成功。

## 域名限速与重试

页面读取和 Map 主请求共享进程内 hostname 限速。默认同主机尝试至少间隔 250ms，每页最多尝试
3 次。只重试 `retryable=true` 的超时、429、上游错误等；访问拒绝、付费墙、登录墙、robots
禁止和内容错误只尝试一次。退避默认从 500ms 指数增长，单次不超过 30000ms。

429 的合法 `Retry-After` 必须被遵守；如果它超过管理员允许的最大等待，则保留失败而不是提前
重试。异步 Crawl Job 取消可以打断退避等待。新鲜成功结果的 evidence 返回 `attempts`、
`totalRetryDelayMs`、按 HTTP/Browser 拆分的 fetch 次数、响应字节和耗时；最终失败在 details
返回同样的扁平成本证据，供 Benchmark 和后续 Attempt Ledger 归因。

## 管理员代理池

`DIAOYAN_PROXY_URLS` 可配置逗号分隔的 HTTP(S) 代理。该配置只能由管理员提供，不接受 Agent
工具参数。普通请求按进程内 round-robin 轮换；同一次 HTTP 重定向链和同一个浏览器上下文固定
出口；授权 Profile 根据名称稳定绑定代理，手动登录与后续抓取保持一致。

代理目标不改变 URL policy：初始 URL、重定向和浏览器子请求继续执行 SSRF 与公网校验。结果
只返回 `evidence.proxyUsed`，不得返回代理 URI、池索引或凭证。代理连接失败沿用既有 retryable
错误与 v0.6 退避策略。

## 自有 Agent 身份

管理员可通过 `DIAOYAN_AGENT_IDENTITY_URL` 声明自有的公开 HTTPS 身份，并通过
`DIAOYAN_WEB_BOT_AUTH_JWK_PATH` 为 HTTP 抓取开启 Web Bot Auth 签名。私钥文件必须为
Ed25519 私钥 JWK、使用绝对路径，并在 POSIX 系统上拒绝 group/other 权限。私钥、路径和完整
JWK 不得出现在工具输入、返回、缓存或错误 details。

当前只实现 Cloudflare 现行验证器所接受的 `cloudflare-legacy` 报文档，使用 RFC 9421 签名
`@authority` 与 `signature-agent`，重定向逐跳重新签名。签名只证明请求携带了某个自有密钥，
不代表站点已经注册或信任该 Agent，也不得用于绕过 robots、认证、付费或访问拒绝。

浏览器路径不发送 Web Bot Auth 签名。新鲜结果的 `evidence.agentIdentity` 必须准确返回最终内容
请求使用的 User-Agent、公开身份 URL、`signed` 状态和兼容档，不得把浏览器结果标成已签名。
旧缓存结果可以没有该字段。完整约束见 `docs/agent-identity-spec.md`。

## RSL 许可策略

页面正文进入提取、缓存或 Agent 上下文前，必须检查当前 User-Agent group 的 robots `License:`、
HTTP RSL Link、HTML RSL link 和 inline script。外部 RSL 文件继续经过 URL policy、DNS、重定向、
响应大小和内容类型校验；声明存在但无法安全判断时返回 `RSL_INVALID`，不得静默放行。

管理员通过 `DIAOYAN_RSL_USAGE` 声明稳定用途，默认 `ai-input`；可选配置真实的 user class 与 geo。
明确禁止返回 `RSL_PROHIBITED`，缺少对应 OLP client 的 License Server 返回
`RSL_LICENSE_REQUIRED`，付费或 custom 流程返回 `RSL_PAYMENT_REQUIRED`，未批准的归因、standard、
reporting、legal 或 terms 返回 `RSL_CONFIRMATION_REQUIRED`。服务不自动购买许可或提交报告。

付费声明必须严格解析 type、静态 amount/currency、`accepts` 协议媒体类型和 custom 流程位置。
合法声明仍 fail closed，但 `RSL_PAYMENT_REQUIRED` details 返回结构化 quote；访问审计持久记录同一
quote，并固定标记预算 `disabled`、结算 `not-attempted`。服务不执行协议 payload，不调用钱包、
x402 facilitator、支付 Provider 或 custom endpoint。完整边界见 `docs/rsl-payment-boundary-spec.md`。

新鲜结果的 `evidence.rsl` 返回用途、决策状态、发现方式与公开许可 URL。`not-declared` 只说明
支持的发现面没有 RSL 声明，不代表不存在版权、站点条款或其他许可义务。RSS 与媒体容器元数据
尚未实现，因此当前能力不得宣称完整 RSL Conformance。完整边界见 `docs/rsl-policy-spec.md`。

## RSL 批准与访问审计

管理员可在 mode-0600 的 `DIAOYAN_RSL_APPROVALS_PATH` 文件中批准 attribution、standard、legal
或 terms 义务。批准必须精确绑定 `<license>` XML Hash、`<content url>`、usage、user class、geo、
全部义务和未来到期时间。服务不通过 MCP 或普通 CLI 修改批准文件，批准到期后立即停止命中，
页面缓存键同步变化。禁止、付费、reporting 和 License Server 不能由静态批准放行。

每次最终页面读取向 `cache.sqlite` 的独立审计表写入成功或失败、去 query 的 URL、fetch/cache
状态、RSL 决策、许可 URL/Hash、批准数量和安全付款 quote。审计不保存正文、标题、authProfile、Token、Cookie、
客户端密钥或代理配置。写入失败必须使读取失败。`diaoyan rsl-audit` 和 `get_rsl_audit` 只读返回
最近最多 1000 条安全字段。完整约束见 `docs/rsl-approval-audit-spec.md`。

## RSL OLP 与 CAP

管理员可在 mode-0600 的 `DIAOYAN_RSL_CLIENTS_PATH` 中为精确 HTTPS License Server 配置 OAuth
client。只有已经满足用途/用户/地区约束、没有付费或 reporting 条款、且其非付款义务已精确批准的
许可可以请求 OLP `/token`。请求使用直连 HTTPS、HTTP Basic、表单编码、64 KiB 响应上限且禁止
重定向；返回的 opaque Token 只保存在进程内存。

HTTP 主文档通过 robots 预声明或一次 401/402 challenge 获得 Token 后使用
`Authorization: License <token>`。浏览器只对主 frame 导航使用 robots 预声明的 Token。每个
重定向目标独立重新判断，不继承前一目标的 Header。证据与逐次审计只记录实际应用 Token 的数量，
不记录 Token 或 client ID。完整边界见 `docs/rsl-olp-cap-spec.md`。

## 浏览器 Worker 池

无授权 Profile 的动态页面使用进程内浏览器池。默认最多 2 个 Chrome 实例，每个实例最多 4 个
并发隔离 Context。浏览器按直连或代理出口分组复用，每页新建 Context，不共享 Cookie 或
Storage。池满时事件等待，默认上限 30000ms；超时返回 retryable 的
`BROWSER_POOL_EXHAUSTED`，异步任务取消可中断等待。

使用授权 Profile 的持久 Context 不进入匿名池，继续独占串行。浏览器断连、启动失败和应用关闭
必须释放池容量；应用关闭先停止 Crawl Job，再关闭池内浏览器。

## 运行统计

`read_page`、`inspect_page`、同步 Crawl 和异步 Crawl 的逐页读取写入 `cache.sqlite` 中独立的
UTC 日聚合表。每次调用只记录一个最终成功或失败，重试证据作为该调用的成本数据累加。Map 与
Search 暂不计入，避免把链接发现或搜索 Provider 成功率混入正文读取成功率。

统计仅报告可直接测量的数据，不估算代理、带宽、CPU、浏览器或第三方服务的货币费用。SQLite
写入或查询失败必须显式失败，不得静默丢失数据。

## 变化检测与定时调度

长期 MCP 服务运行独立的单 Monitor Worker。Worker 只为最近的 `nextRunAt` 注册一次精确计时器，
不固定频率空轮询。任务完成后从完成时间加间隔，避免慢任务重叠或追赶积压周期。普通 CLI 不
恢复或执行 Monitor。

遗留 `running` 状态在服务启动时恢复为立即到期的 `scheduled`。应用关闭时取消当前读取并重新
排队，用户取消则进入永久 `cancelled`。Monitor 只读取创建时的一个 URL，不发现链接、不发送
Webhook，也不把读取错误转换成“未变化”。

## 错误代码

- `INVALID_URL`
- `INVALID_ARGUMENT`
- `SSRF_BLOCKED`
- `ROBOTS_DISALLOWED`
- `ROBOTS_UNAVAILABLE`
- `AUTH_REQUIRED`
- `PAYMENT_REQUIRED`
- `ACCESS_DENIED`
- `RATE_LIMITED`
- `UPSTREAM_ERROR`
- `FETCH_TIMEOUT`
- `UNSUPPORTED_CONTENT_TYPE`
- `RESPONSE_TOO_LARGE`
- `LOGIN_WALL_DETECTED`
- `HUMAN_VERIFICATION_REQUIRED`
- `SHELL_ONLY`
- `INCOMPLETE_CONTENT`
- `BROWSER_UNAVAILABLE`
- `BROWSER_POOL_EXHAUSTED`
- `PROFILE_NOT_FOUND`
- `CACHE_MISS`
- `SEARCH_PROVIDER_NOT_CONFIGURED`
- `SEARCH_PROVIDER_ERROR`
- `JOB_NOT_FOUND`
- `MONITOR_NOT_FOUND`
- `CRAWL_CANCELLED`
- `INTERNAL_ERROR`

不得用成功响应包装上述失败。

## 安全边界

- 仅允许 `http` 和 `https`。
- 拒绝 URL 中的用户名和密码。
- 每次初始请求和重定向都校验目标；拒绝 loopback、私网、链路本地、保留地址和云元数据地址。
- 浏览器子请求同样执行目标校验。
- 默认遵守 `robots.txt`；规则明确禁止或无法安全取得规则时失败关闭。
- 限制重定向次数、响应体大小、请求时间和浏览器执行时间。
- HTTP 路径不执行页面脚本；浏览器运行在专用 Profile 中。
- Profile 和 SQLite 数据放在仓库外的数据目录；Profile 内容永不通过 MCP 返回。
- 缓存只保存成功、完整的读取结果。
- 站点 Map/Crawl 默认同主机、串行、有界；不自动扩大到外域或子域。

## 内容完整性

提取顺序：Mozilla Readability，失败后才使用清理过的 `body`。HTML 在转 Markdown 前移除脚本、样式、表单、嵌入对象和危险 URL。

以下情况必须失败：

- 已知 CAPTCHA、机器人挑战或访问验证页面。
- 明确登录墙或订阅墙。
- 只有应用壳、加载占位符或正文低于最小阈值。
- Content-Type 不受支持。

返回证据必须足以区分 HTTP 成功、正文成功和缓存命中。

## 低成本内容验收

验收层只复用提取阶段已有数据，不发起额外请求，不调用 LLM 或 Embedding，也不启动第二次浏览器读取。

- 正常 Readability/纯文本结果返回 `usable`。
- 通过完整性门槛但少于 500 个字符时返回 `uncertain` 和 `SHORT_CONTENT`。
- Readability 不足并使用清理后的 document 兜底时返回 `uncertain` 和 `FALLBACK_EXTRACTION`。
- 挑战页、登录墙、付费墙、应用壳和不完整正文继续返回结构化错误，不进入成功验收结果。

该状态只描述提取可信度，不评价来源权威性、事实真实性或与 Agent 任务的相关性。

## 本地数据

默认数据目录为平台用户数据目录下的 `diaoyan`，可通过 `DIAOYAN_DATA_DIR` 覆盖。

- `cache.sqlite`: 成功正文缓存、持久 Crawl Job、页面 Monitor、隐私安全的运行聚合，以及显式启用时的本地 FTS5 全文索引。
- `profiles/<name>/`: 专用 Chromium Profile。

Profile 名称只允许字母、数字、点、下划线和连字符。

Clash/TUN Fake-IP 兼容必须通过 `DIAOYAN_ALLOW_DNS_FAKE_IP=1` 显式开启。它只允许域名解析所得的
`198.18.0.0/15` 地址，URL 直接使用该网段仍按 SSRF 拦截。

## 验收

- TypeScript 构建无错误。
- 单元测试覆盖 URL/SSRF、状态码映射、登录墙、挑战页、壳页、正文提取和缓存。
- 单元测试覆盖站点范围、URL 去重、查询参数、深度、截断和部分失败语义。
- 单元测试覆盖低成本验收状态与稳定 warning code。
- MCP 客户端可以列出并调用十四个工具。
- 公开页面读取后可通过 `source=local` 搜索，重复 URL 更新且授权页面不入索引。
- 异步任务可完成、失败、取消并在服务重启后恢复。
- retryable 页面失败按上限恢复，非 retryable 失败不重试，同主机尝试遵守最小间隔。
- HTTP 和浏览器可使用管理员代理池，Profile 绑定稳定且结果不泄露代理配置。
- 匿名浏览器复用有界实例并逐页隔离 Context，池容量等待可取消、超时和安全关闭。
- 内容读取按 UTC 日持久聚合成功、失败、缓存、方法和成本证据，且不保存 URL 或正文。
- 页面 Monitor 可建立 Hash 基线、检测变化、失败后继续调度、取消并在服务重启后恢复。
- 对公开静态页面的真实冒烟读取返回正文和证据。
- 对 402/403 或机器人挑战页面返回明确错误，不能返回伪正文。
