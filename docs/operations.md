# Crawlume 部署与运维手册

本文面向部署和值守 Crawlume 的人员。接口合同以 [`spec.md`](./spec.md) 为准，这里只描述怎么跑、怎么看、
怎么恢复。

## 1. 运行形态

| 形态 | 启动方式 | 存储 | 适用 |
|---|---|---|---|
| 本地 MCP | `node dist/server.js`（stdio） | `CRAWLUME_DATA_DIR` 下的 SQLite | 单机 Agent |
| 容器 MCP | `docker run --rm -i -v crawlume-data:/data crawlume` | `/data` 卷 | 隔离运行、固定 Chromium |
| Control Plane | `node dist/server.js --control-plane` | PostgreSQL | 多项目 API、远程 Worker |
| CLI | `node dist/cli/main.js <command>` | 与 MCP 共用数据目录 | 运维与排障 |

运行时要求 Node.js 24 LTS（≥24.14）或 Node.js 26；浏览器模式需要 Chrome，容器镜像自带 Chromium。

## 2. 数据目录

- 默认位置：macOS `~/Library/Application Support/crawlume/`，Linux `$XDG_DATA_HOME/crawlume`
  或 `~/.local/share/crawlume`，Windows `%LOCALAPPDATA%\crawlume`。
- `cache.sqlite`：缓存、Artifact、Attempt Ledger、Frontier、统计和可选本地索引，WAL 模式。
- `profiles/`：授权浏览器 Profile，含登录态，按凭证对待，不要进入备份共享或镜像。
- `rsl-approvals.json`、`rsl-clients.json`：RSL 许可批准和客户端凭证。

同一个数据目录同一时间只应由一个长期 MCP 进程使用；CLI 可以并行做只读查询和备份。

## 3. 本地运行配置

所有变量都有默认值，非法值会让进程启动失败，不会静默回退。

| 变量 | 默认 | 说明 |
|---|---|---|
| `CRAWLUME_DATA_DIR` | 见上 | 运行数据目录 |
| `CRAWLUME_USER_AGENT` | `Crawlume/0.10` | 对外 User-Agent |
| `CRAWLUME_REQUEST_TIMEOUT_MS` | 20000 | HTTP 单次超时 |
| `CRAWLUME_BROWSER_TIMEOUT_MS` | 30000 | 浏览器单页超时 |
| `CRAWLUME_MAX_RESPONSE_BYTES` | 5000000 | 主文档字节上限 |
| `CRAWLUME_MAX_REDIRECTS` | 5 | 重定向上限 |
| `CRAWLUME_ROBOTS_CACHE_SECONDS` | 3600 | robots 缓存 |
| `CRAWLUME_DEFAULT_CACHE_SECONDS` | 900 | 页面缓存 TTL |
| `CRAWLUME_CRAWL_MAX_ATTEMPTS` | 3 | 1–10，每页最大尝试 |
| `CRAWLUME_CRAWL_RETRY_BASE_MS` | 500 | 退避基数 |
| `CRAWLUME_CRAWL_MAX_RETRY_DELAY_MS` | 30000 | 单次退避上限 |
| `CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS` | 250 | 同 host 最小间隔 |
| `CRAWLUME_CRAWL_WORKER_CONCURRENCY` | 8 | 1–32，全局 Worker 并发 |
| `CRAWLUME_CRAWL_LEASE_MS` | 5000 | Frontier lease 时长 |
| `CRAWLUME_BROWSER_POOL_SIZE` | 2 | 1–16，Chrome 实例数 |
| `CRAWLUME_BROWSER_CONTEXTS_PER_INSTANCE` | 4 | 每实例 Context 并发 |
| `CRAWLUME_BROWSER_POOL_WAIT_MS` | 30000 | 池满等待上限 |
| `CRAWLUME_BROWSER_CHANNEL` | `chrome` | Playwright channel |
| `CRAWLUME_BROWSER_EXECUTABLE` | 无 | 指定浏览器可执行文件，优先于 channel |
| `CRAWLUME_PROXY_URLS` | 无 | 管理员代理池 |
| `CRAWLUME_ALLOW_DNS_FAKE_IP` | 0 | 仅本机 DNS 为 Fake-IP 模式时开启 |
| `CRAWLUME_LOCAL_INDEX_ENABLED` | 0 | 本地 FTS 索引 |
| `CRAWLUME_SEARXNG_URL` | 无 | 外部搜索 Provider |
| `CRAWLUME_METRICS_PORT` / `CRAWLUME_METRICS_HOST` | 无 / `127.0.0.1` | Prometheus 端点 |
| `CRAWLUME_AGENT_IDENTITY_URL`、`CRAWLUME_WEB_BOT_AUTH_*` | 无 | 公开身份与 Web Bot Auth 签名 |
| `CRAWLUME_RSL_*` | 见 spec | RSL 用途、用户类别、地域和文件路径 |

## 4. Control Plane

`--control-plane` 模式连接 PostgreSQL，启动时执行 `migrations/control-plane/` 下的迁移，并提供
[`project-control-api.openapi.yaml`](./project-control-api.openapi.yaml) 与
[`worker-control-api.openapi.yaml`](./worker-control-api.openapi.yaml) 描述的 HTTP API。

必填变量：

- `DIAOYAN_CONTROL_DATABASE_URL`：`postgres://` 或 `postgresql://`，不得在 URL 中写 TLS 参数；非回环地址
  强制校验证书，自签 CA 用 `DIAOYAN_CONTROL_DATABASE_CA_PATH`。
- `DIAOYAN_OIDC_ISSUER`、`DIAOYAN_OIDC_AUTHORIZATION_ENDPOINT`、`DIAOYAN_OIDC_TOKEN_ENDPOINT`、
  `DIAOYAN_OIDC_CLIENT_ID`、`DIAOYAN_OIDC_REDIRECT_URI`、`DIAOYAN_OIDC_JWKS_URI`、
  `DIAOYAN_OIDC_ID_TOKEN_ALGORITHM`。
- `DIAOYAN_HUMAN_ACCESS_TOKEN_ISSUER`、`DIAOYAN_HUMAN_ACCESS_TOKEN_AUDIENCE`、
  `DIAOYAN_HUMAN_ACCESS_TOKEN_PRIVATE_KEY_PATH`、`DIAOYAN_HUMAN_ACCESS_TOKEN_PUBLIC_KEY_PATH`。
- `DIAOYAN_WORKER_SESSION_ISSUER`、`DIAOYAN_WORKER_SESSION_AUDIENCE`、
  `DIAOYAN_WORKER_SESSION_PRIVATE_KEY_PATH`、`DIAOYAN_WORKER_SESSION_PUBLIC_KEY_PATH`。

两组签名密钥都是 Ed25519 PEM，启动时会做签名自检，不匹配直接失败。可选：
`DIAOYAN_CONTROL_HOST`（默认 `127.0.0.1`）、`DIAOYAN_CONTROL_PORT`（默认 8787）、
`DIAOYAN_CONTROL_TLS_KEY_PATH` 与 `DIAOYAN_CONTROL_TLS_CERT_PATH`（必须成对）。

对外暴露时应启用 TLS 或放在终止 TLS 的反向代理之后，并只开放 API 端口。

### 配额

以下变量对每个 Project 生效，未设置即不限制，非法值启动失败。超限请求返回 HTTP 429 `QUOTA_EXCEEDED`；
随时间重置的配额带 `Retry-After` 且 `retryable: true`。

| 变量 | 统计方式 |
|---|---|
| `DIAOYAN_QUOTA_ACTIVE_JOBS` | 当前处于 accepted/queued/assigned/running/paused 的 Job 数 |
| `DIAOYAN_QUOTA_MONTHLY_PROVIDER_ATTEMPTS` | 本 UTC 月创建的 Job 预留的 `max_provider_attempts` 之和 |
| `DIAOYAN_QUOTA_MONTHLY_BROWSER_MINUTES` | 本 UTC 月创建的 Job 预留的 `max_browser_ms` 之和（按分钟配置） |
| `DIAOYAN_QUOTA_ARTIFACT_BYTES` | Project 已登记 Artifact 的 `byte_count` 之和，达到即拒绝新 Job |
| `DIAOYAN_QUOTA_API_REQUESTS_PER_MINUTE` | 每个 API Key 每分钟请求数，按单个 Control Plane 进程计数 |

配额在创建 Job 的事务内用 Project 级 advisory lock 检查；同一 `Idempotency-Key` 的重放不重复计入。

### Webhook

设置 `DIAOYAN_WEBHOOK_ENCRYPTION_KEY_PATH` 指向一个 32 字节密钥文件（原始字节、64 位十六进制或 base64）后启用；
未设置时 Webhook 管理接口返回 503 `WEBHOOKS_DISABLED`，也不启动投递循环。生成密钥：

```bash
openssl rand -out /etc/diaoyan/webhook.key 32 && chmod 600 /etc/diaoyan/webhook.key
```

- 事件：`job.completed`、`job.failed`、`job.cancelled`。数据库触发器在 Job 进入终态的同一事务内写入事件并为
  订阅的 active Endpoint 生成投递，任何终态路径（Worker 完成、取消、lease 超时）都不会漏发。
- Endpoint 只接受公网 https URL，注册和每次投递都做 SSRF 检查，不跟随重定向。
- Endpoint secret 以 AES-256-GCM 加密保存；丢失密钥文件后已有 Endpoint 无法再签名，需要重新注册。
- 投递每秒扫描一次，单次 10 秒超时，2xx 记为成功；失败按 30 秒起的指数退避（上限 1 小时，尊重
  `Retry-After`）重试，第 8 次失败或 Endpoint 已停用时进入 `dead_letter`。每次尝试写入
  `webhook_delivery_attempts`。
- 请求体只含事件 ID、类型和 Job 状态，不含正文。签名格式见 [`sdk.md`](./sdk.md)。

## 5. 可观测性

- 日志：进程事件以 JSON Lines 写到 stderr（`time`、`level`、`event` 和字段），stdout 只用于 MCP。
- 指标：设置 `CRAWLUME_METRICS_PORT` 后抓取 `GET /metrics`，计数器定义见
  [`runtime-metrics-spec.md`](./runtime-metrics-spec.md)。建议告警：
  - `rate(crawlume_reads_total{outcome="failure"}[15m]) / rate(crawlume_reads_total[15m])` 持续升高。
  - 某个 `error_code`（如 `SSRF_BLOCKED`、`RATE_LIMITED`）突增。
  - `/metrics` 返回 500：聚合表不可读，按存储故障处理。
- 明细：`crawlume stats --days <1-90>` 和 MCP `get_crawler_stats` 给出窗口内成功率、失败原因和成本。

## 6. 备份与恢复

本地 SQLite：

```bash
crawlume backup /backups/crawlume-2026-10-22.sqlite
crawlume restore /backups/crawlume-2026-10-22.sqlite /srv/crawlume-restored/cache.sqlite
```

- `backup` 使用 SQLite online backup，可在 MCP 运行时执行；写出备份文件和同名 `.json` 校验元数据
  （integrity check、页数、字节数、SHA-256），已存在的目标拒绝覆盖。
- `restore` 先校验元数据，再恢复到一个不存在的新路径，不会覆盖运行中的数据库。切换方式：停止进程，
  把恢复出的文件放到新的 `CRAWLUME_DATA_DIR` 下命名为 `cache.sqlite`，再启动。
- `profiles/` 不在 SQLite 中，需要时单独加密备份。

Control Plane 的 PostgreSQL 使用数据库自身的备份方案（`pg_dump` 或托管快照），应用不提供替代。

## 7. 升级

1. 阅读 `CHANGELOG.md`。
2. 先执行 `crawlume backup`；Control Plane 先做 PostgreSQL 快照。
3. 替换构建产物或镜像，重启进程。SQLite 表和 Control Plane 迁移在启动时自动应用；迁移失败时进程退出，
   不会带着半迁移的 Schema 继续服务。
4. 用 `crawlume stats --days 1` 或 `/metrics` 确认读取恢复正常。

回滚：停止新版本，使用升级前的备份恢复到新路径，再启动旧版本。

## 8. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 所有读取返回 `SSRF_BLOCKED` | 本机 DNS 为 Fake-IP（如 Clash/TUN），公网域名解析到保留地址 | 确认后设置 `CRAWLUME_ALLOW_DNS_FAKE_IP=1` |
| 浏览器模式失败，提示 executable/channel | 未安装 Chrome | 安装 Chrome，或设置 `CRAWLUME_BROWSER_EXECUTABLE` |
| 启动报 `... must be an integer between ...` | 环境变量越界 | 按第 3 节修正 |
| stderr 出现 SQLite `ExperimentalWarning` | Node 24 中 `node:sqlite` 仍标为实验特性 | 无害；可加 `--disable-warning=ExperimentalWarning` |
| `/metrics` 返回 500 | 聚合表读取失败 | 检查磁盘、权限和 SQLite 锁 |
