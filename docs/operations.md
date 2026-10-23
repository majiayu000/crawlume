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

运行时要求 Node.js 24 LTS（≥24.15）或 Node.js 26；浏览器模式需要 Chrome，容器镜像自带 Chromium。

## 2. 数据目录

- 默认位置：macOS `~/Library/Application Support/crawlume/`，Linux `$XDG_DATA_HOME/crawlume`
  或 `~/.local/share/crawlume`，Windows `%LOCALAPPDATA%\crawlume`。
- `cache.sqlite`：缓存、Artifact、Attempt Ledger、Frontier、统计和可选本地索引，WAL 模式。
- `profiles/`：授权浏览器 Profile，含登录态，按凭证对待，不要进入备份共享或镜像。
- `traces/`：浏览器失败诊断 JSON；SQLite 中只保存 `trace_ref`，不包含这些文件。
- `rsl-approvals.json`、`rsl-clients.json`：RSL 许可批准和客户端凭证。

同一个数据目录同一时间只应由一个长期 MCP 进程使用；CLI 可以并行做只读查询和备份。

## 3. 本地运行配置

下表列出本地运行默认值。布尔、枚举和带范围的整数项会检查允许值或解析后的范围；
`CRAWLUME_REQUEST_TIMEOUT_MS`、`CRAWLUME_BROWSER_TIMEOUT_MS`、`CRAWLUME_MAX_RESPONSE_BYTES`、
`CRAWLUME_MAX_REDIRECTS`、`CRAWLUME_ROBOTS_CACHE_SECONDS` 和 `CRAWLUME_DEFAULT_CACHE_SECONDS`
使用 `parseInt(value, 10)`，会接受 `20000ms` 这样的数字前缀，
`1e4` 会被读成 `1`。部署时请填写普通十进制整数，不依赖这类宽松解析；无法解析或非正数会启动失败。

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

- `DIAOYAN_CONTROL_DATABASE_URL`：`postgres://` 或 `postgresql://`，不得在 URL 中写 TLS 参数；只有字面地址 `127.0.0.1`
  和 `::1` 且未指定 CA 时使用明文，`localhost` 等其他主机名均强制校验证书。自签 CA 用
  `DIAOYAN_CONTROL_DATABASE_CA_PATH`，该文件同样须为非符号链接的普通文件。
- `DIAOYAN_OIDC_ISSUER`、`DIAOYAN_OIDC_AUTHORIZATION_ENDPOINT`、`DIAOYAN_OIDC_TOKEN_ENDPOINT`、
  `DIAOYAN_OIDC_CLIENT_ID`、`DIAOYAN_OIDC_REDIRECT_URI`、`DIAOYAN_OIDC_JWKS_URI`、
  `DIAOYAN_OIDC_ID_TOKEN_ALGORITHM`。
- `DIAOYAN_HUMAN_ACCESS_TOKEN_ISSUER`、`DIAOYAN_HUMAN_ACCESS_TOKEN_AUDIENCE`、
  `DIAOYAN_HUMAN_ACCESS_TOKEN_PRIVATE_KEY_PATH`、`DIAOYAN_HUMAN_ACCESS_TOKEN_PUBLIC_KEY_PATH`。
- `DIAOYAN_WORKER_SESSION_ISSUER`、`DIAOYAN_WORKER_SESSION_AUDIENCE`、
  `DIAOYAN_WORKER_SESSION_PRIVATE_KEY_PATH`、`DIAOYAN_WORKER_SESSION_PUBLIC_KEY_PATH`。

两组签名密钥都是 Ed25519 PEM，公钥和私钥均须为非符号链接的普通文件；私钥还须只允许所有者访问（例如 `0600`）；
私钥采用常见的 `0644` Secret 挂载会被拒绝。启动时会做签名自检，不匹配直接失败。可选：
`DIAOYAN_CONTROL_HOST`（默认 `127.0.0.1`）、`DIAOYAN_CONTROL_PORT`（默认 8787）、
`DIAOYAN_CONTROL_TLS_KEY_PATH` 与 `DIAOYAN_CONTROL_TLS_CERT_PATH`（必须成对）。
TLS key 和 cert 均须为非符号链接的普通文件，key 还须使用 owner-only 权限（如 `0600`）；
`0644` 私钥或符号链接形式的 Secret 挂载会被拒绝。

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

- 日志：MCP 和 Control Plane 服务端入口的进程事件以 JSON Lines 写到 stderr（`time`、`level`、`event` 和字段），stdout 只用于 MCP。
- 指标（仅本地/容器 MCP runtime）：设置 `CRAWLUME_METRICS_PORT` 后抓取 `GET /metrics`，计数器定义见
  [`runtime-metrics-spec.md`](./runtime-metrics-spec.md)。`--control-plane` 不启动此端点。建议告警：
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
  备份与恢复目标文件系统必须支持并允许 hardlink（例如 exFAT 不支持）；`backup` 会在复制前用私有 staging 文件检查，
  不满足即拒绝。完成后 staging 清理失败会警告但保留成功结果，私有 staging 可能残留，警告会指出路径；
  备份本身失败时保留原始错误。
- `restore` 将备份复制到目标目录的私有 pending 文件，只在该副本上完整校验元数据、SHA-256 和 SQLite integrity，
  成功后发布到一个不存在的新路径；源归档可只读，不会在源目录创建 WAL/SHM。独立校验也使用可写临时副本，需有临时磁盘空间。
  目标及其 `-wal`、`-shm`、`-journal` 必须均不存在。
  恢复期间保持目标离线，不会覆盖运行中的数据库。切换方式：停止进程，
  把恢复出的文件放到新的 `CRAWLUME_DATA_DIR` 下命名为 `cache.sqlite`，再启动。
- `profiles/`、`traces/`、`rsl-approvals.json` 和 `rsl-clients.json` 不在 SQLite 中，需要单独加密备份。
  切换数据目录时，在进程停止期间把两个 RSL 文件安全恢复到新 `CRAWLUME_DATA_DIR`（或相应的自定义路径），
  保留 owner-only 权限，并按需恢复 `profiles/` 和 `traces/`；复制这些目录和文件期间也须停止进程，
  保护 Profile 内的登录会话凭据。仅恢复 `cache.sqlite` 不会恢复审批、OLP 客户端凭据或 trace 文件。
- 本地运行配置也须安全保存。启用 Web Bot Auth 时，另行加密备份
  `CRAWLUME_WEB_BOT_AUTH_JWK_PATH` 指向的 Ed25519 私有 JWK，并恢复其路径、owner-only 权限和
  `CRAWLUME_AGENT_IDENTITY_URL` 等签名配置；该文件可以在数据目录外，不包含在 SQLite 备份中。

Control Plane 的 PostgreSQL 使用数据库自身的备份方案（`pg_dump` 或托管快照），应用不提供替代。
云端或 `worker_local` 的 Artifact 元数据只记录引用；如使用外部 payload 存储，还须另行保留对应内容，
PostgreSQL dump 不等于这些 payload 的备份。
数据库备份不包含 Secret 卷或运行配置。灾难恢复还须从受保护的独立备份恢复第 4 节的四个 PEM 文件：
Human access-token 和 Worker session 各自匹配、且两组互异的 Ed25519 公私钥；保留原 issuer/audience，
更换签名密钥会使原有 token 无法验证。私钥保持 owner-only，四个文件均须为非符号链接的普通文件。
同时恢复 PostgreSQL 连接配置及凭据、OIDC 配置（含 issuer、端点、client ID、redirect URI、JWKS URI 和算法），
以及启用时的 `DIAOYAN_CONTROL_DATABASE_CA_PATH` CA 文件和 `DIAOYAN_CONTROL_TLS_KEY_PATH` /
`DIAOYAN_CONTROL_TLS_CERT_PATH` TLS 配对文件；文件要求见第 4 节。恢复后先确认数据库、密钥和配置一致，再启动服务。

## 7. 升级

1. 阅读 `CHANGELOG.md`。
2. 先执行 `crawlume backup`；Control Plane 先做 PostgreSQL 快照。
3. 替换构建产物或镜像，重启进程。SQLite 表和 Control Plane 迁移在启动时自动应用；迁移失败时进程退出。
   SQLite 各 store 的初始化不共享整体事务，失败时可能已部分升级；保持进程停止并从升级前备份恢复到新路径，
   再启动原版本，不要直接用原数据库反复尝试升级。
4. MCP 用 `crawlume stats --days 1` 或 `/metrics` 确认读取恢复正常；Control Plane 通过其 HTTP API 验证。

回滚：停止新版本，使用升级前的备份恢复到新路径，再启动旧版本。

## 8. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 所有读取返回 `SSRF_BLOCKED` | 本机 DNS 为 Fake-IP（如 Clash/TUN），公网域名解析到保留地址 | 确认后设置 `CRAWLUME_ALLOW_DNS_FAKE_IP=1` |
| 浏览器模式失败，提示 executable/channel | 未安装 Chrome | 安装 Chrome，或设置 `CRAWLUME_BROWSER_EXECUTABLE` |
| 启动报 `... must be an integer between ...` | 环境变量越界 | 按第 3 节修正 |
| stderr 出现 SQLite `ExperimentalWarning` | Node 24 中 `node:sqlite` 仍标为实验特性 | 无害；可加 `--disable-warning=ExperimentalWarning` |
| `/metrics` 返回 500 | 聚合表读取失败 | 检查磁盘、权限和 SQLite 锁 |

配额边界：`DIAOYAN_QUOTA_ARTIFACT_BYTES` 只在新建 Job 时检查当前已登记的 artifact 字节，
不预留未来产物空间，也不在写入产物时强制存储硬上限。`DIAOYAN_QUOTA_API_REQUESTS_PER_MINUTE`
按每个 Control Plane 进程内的 API key 计数，多实例部署不共享计数；不能据此宣称全局请求上限。
月度预算以获取 Project 锁之后的 PostgreSQL 时钟和 `[本月初, 下月初)` UTC 窗口计算；
统计的是该窗口内创建的 Job 预留预算，不是按执行发生月份计量的实际用量。
