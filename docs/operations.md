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

两组签名密钥都是 Ed25519 PEM，私钥必须是非符号链接的普通文件，且只允许所有者访问（例如 `0600`）；
常见的 `0644` Secret 挂载会被拒绝。启动时会做签名自检，不匹配直接失败。可选：
`DIAOYAN_CONTROL_HOST`（默认 `127.0.0.1`）、`DIAOYAN_CONTROL_PORT`（默认 8787）、
`DIAOYAN_CONTROL_TLS_KEY_PATH` 与 `DIAOYAN_CONTROL_TLS_CERT_PATH`（必须成对）。

对外暴露时应启用 TLS 或放在终止 TLS 的反向代理之后，并只开放 API 端口。

## 5. 可观测性

- 日志：MCP 和 Control Plane 服务端入口的进程事件以 JSON Lines 写到 stderr（`time`、`level`、`event` 和字段），stdout 只用于 MCP。
- 指标：设置 `CRAWLUME_METRICS_PORT` 后抓取 `GET /metrics`，计数器定义见
  [`runtime-metrics-spec.md`](./runtime-metrics-spec.md)。建议告警：
  - `sum(rate(crawlume_reads_total{outcome="failure"}[15m])) / sum(rate(crawlume_reads_total[15m]))` 持续升高。
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
- `restore` 先校验元数据，再恢复到一个不存在的新路径；目标及其 `-wal`、`-shm`、`-journal` 必须均不存在。
  恢复期间保持目标离线，不会覆盖运行中的数据库。切换方式：停止进程，
  把恢复出的文件放到新的 `CRAWLUME_DATA_DIR` 下命名为 `cache.sqlite`，再启动。
- `profiles/`、`rsl-approvals.json` 和 `rsl-clients.json` 不在 SQLite 中，需要单独加密备份。
  切换数据目录时，在进程停止期间把两个 RSL 文件安全恢复到新 `CRAWLUME_DATA_DIR`（或相应的自定义路径），
  保留 owner-only 权限，并按需恢复 `profiles/`。仅恢复 `cache.sqlite` 不会恢复审批或 OLP 客户端凭据。

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
