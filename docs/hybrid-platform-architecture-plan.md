# Diaoyan 混合交付平台架构与实施计划

状态：Proposed
决策：采用方案 C——云端控制面、公共云 Worker、用户或企业私有 Worker
适用范围：C 端个人用户、B 端开发者与组织用户
基线版本：Diaoyan v0.10.4，本地模块化 Retrieval Runtime
最后更新：2026-09-01

## 1. 文档目的

本文把 Diaoyan 从已实现的本地网页访问内核，演进为同时服务 C 端与 B 端的混合交付产品。它定义：

- 产品完成边界和明确非目标。
- 云端控制面、公共 Worker、私有 Worker 的职责。
- 账号、Project、API Key、Worker 身份和数据隔离。
- REST、MCP、Worker 协议、Webhook 和结果发布合同。
- PostgreSQL、对象存储和本地 SQLite 的数据所有权。
- 任务状态机、lease、fencing、幂等、重试和断线恢复。
- C 端、B 端入口、用量与预算边界。
- 部署、CI/CD、可观测性、备份、恢复和安全要求。
- 测试、7 天稳定性试验、300,000 页压力测试和发布门槛。
- 按依赖排序的实施阶段、每阶段交付物和完成定义。

本文是目标架构和实施计划，不表示所述云端能力已经实现。已实现事实仍以
[spec.md](./spec.md)、代码和测试为准。

## 2. 状态标签

本文使用以下标签，防止设计被误读为实现：

| 标签 | 含义 |
|---|---|
| `Verified` | 当前仓库已有代码和本次会话 fresh 验证 |
| `Planned` | 已批准进入实施计划，但尚未实现 |
| `Conditional` | 只有量化触发条件满足后才实施 |
| `Unknown` | 缺少真实用户、成本或容量证据，不能提前下结论 |

## 3. 当前基线

### 3.1 已实现能力

当前本地运行时已经具备：

- HTTP、真实 Chrome、Feed、PDF 和 Adapter Provider 合同。
- Planner、Stage Executor、Extractor Registry、Validator Registry。
- Raw/Artifact 内容寻址存储和 SQLite FTS5。
- Durable Crawl Frontier、lease、heartbeat、fencing、pause/resume/cancel。
- 页面 publication cursor、断线重放和最多 30 秒有界等待。
- 资源预算、per-origin delay、429/503 cooldown、Circuit Breaker。
- 授权 Profile、SSRF、robots、RSL、Web Bot Auth 和审计边界。
- Monitor、运行指标、搜索指标、Benchmark、索引发布/回滚和 SQLite 备份。
- CLI 与 MCP stdio。

### 3.2 Fresh 验证

2026-08-31 在当前 `main` 上使用 Node.js 25.9.0 重新执行：

```text
pnpm check
pnpm build
pnpm vitest run --maxWorkers=1
```

结果为 57 个测试文件、504 个测试全部通过，包含真实 Chrome、500 页并发和 1,000 页
`SIGKILL` 恢复。

### 3.3 当前证据缺口

- 现有 Nightly 报告绑定旧 Git SHA，不能证明最新 HEAD 达到 `canary-ready`。
- Benchmark 报告位于 gitignored 目录，没有形成持久、可追溯的发布证据。
- 300,000 只是索引容量合同，不是已完成的真实 300,000 页压力测试。
- 尚无 7 天连续无人值守运行证据。
- 尚无私有 Release Corpus、生产 rollout 或同 Corpus 竞品对照。
- 垂直索引有 `startDailyRun()`，但没有自动调度和公开管理入口。
- 没有托管 REST API、账号、Project、API Key、客户隔离、Webhook、CI 或部署合同。

## 4. 产品目标与完成定义

### 4.1 产品定位

Diaoyan 是面向 AI Agent 和研究工作流的 proof-carrying Web Access 平台。核心价值不是“所有 URL
都返回成功”，而是以可控成本持续返回正确、完整、足够新、可追溯的网页结果；无法获得可靠结果时
明确失败。

### 4.2 C 端目标

C 端用户应能够：

- 在网页工作台提交 URL、搜索、站点 Crawl 和监控。
- 查看任务进度、失败原因、来源证据和历史版本。
- 安装本机 Companion，读取本人授权页面而不上传 Cookie。
- 以 Project 组织页面、查询、监控和引用。
- 导出 Markdown、JSON 和带证据的结果。

### 4.3 B 端目标

B 端用户应能够：

- 使用 REST、MCP 和 TypeScript/Python SDK。
- 通过 Project API Key 创建任务和读取结果。
- 使用幂等键、cursor、Webhook 和明确部分失败。
- 查看用量、预算、质量和审计证据。
- 选择公共云 Worker 或客户网络内的私有 Worker。

### 4.4 第一版完成定义

第一版混合产品只有满足以下条件才完成：

1. 公共云 Worker 能执行公开任务。
2. 私有 Worker 能主动领取任务，且 Cookie、Profile 和内网正文默认不出设备。
3. REST、MCP 和 Web 使用同一任务合同。
4. Project 数据隔离由真实跨租户测试证明。
5. API Key、Worker Key、Webhook Secret 均可创建、轮换和撤销。
6. Job、event、publication、usage 和 audit 在崩溃后保持一致。
7. CI 绑定 Git SHA 保存 Benchmark 与发布证据。
8. 7 天稳定性试验通过。
9. 300,000 页压力测试通过并给出资源曲线。
10. 灰度发布、回滚、备份和恢复演练通过。

## 5. 明确非目标

第一版不实现：

- 自有开放 Web 全量索引。
- embedding、vector、reranker 或 LLM 热路径。
- Kafka、RabbitMQ、Temporal 或多区域调度。
- Kubernetes 平台化、Service Mesh 或复杂 GitOps 门户。
- 自定义角色、部门、权限策略语言或资源级 ACL。
- SSO、SCIM、复杂企业 RBAC。
- 自动购买网页许可、钱包或真实付款 Provider。
- CAPTCHA、登录、付费墙、robots 或站点访问控制绕过。
- Actor 市场、第三方动态插件或远程执行任意代码。

## 6. Adopt / Adapt / Build 决策

### 6.1 Adopt

- REST + OpenAPI 作为公共 B 端 API。
- 标准 OIDC 作为人类身份来源。
- PostgreSQL 作为云端控制面事务数据库。
- 对象存储作为云端 Raw/Artifact 大对象存储。
- 标准容器平台作为第一版部署环境。
- OpenTelemetry 兼容的指标、日志和 Trace 语义。

### 6.2 Adapt

- 复用当前 Reader、Planner、Executor、Validator 和安全策略作为 Worker 内核。
- 复用 Durable Frontier 的 lease、fencing 和 publication 语义。
- 复用当前 Budget 和 Usage 向量作为云端计量来源。
- 复用 MCP 工具语义，但把传输适配到云端 Project 身份。
- 复用本地 SQLite 作为私有 Worker 的权威执行存储。

### 6.3 Build

- 云端控制面。
- Worker 注册、认证、claim、heartbeat 和结果提交协议。
- Project、API Key、用量、审计和 Webhook。
- 公共云 Artifact Store 与私有结果上传批准边界。
- C 端 Web、浏览器插件和本机 Companion。
- 可追溯 Benchmark、CI/CD、部署和生产验收链。

### 6.4 拒绝的替代方案

| 方案 | 决定 | 原因 |
|---|---|---|
| 纯云 SaaS | 拒绝作为唯一模式 | 登录态、内网和隐私页面的信任边界不成立 |
| 纯本地产品 | 拒绝作为唯一模式 | C 端安装门槛高，B 端缺集中 API、用量和 SLA |
| 立即微服务化 | 拒绝 | 当前没有团队、流量和故障域证据 |
| 立即分布式队列 | 拒绝 | PostgreSQL claim 足够验证第一版需求 |
| 重写 Go/Rust | 拒绝 | 当前瓶颈不在 TypeScript 控制面 |

## 7. 总体架构

```text
┌─────────────────────────────────────────────────────────────────┐
│ Clients                                                         │
│ C Web │ Browser Extension │ REST SDK │ MCP Gateway │ Admin CLI  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS
┌──────────────────────────────▼──────────────────────────────────┐
│ Cloud Control Plane — modular monolith                          │
│ Auth │ Projects │ Jobs │ Routing │ Workers │ Usage │ Audit      │
│ Artifacts │ Webhooks │ Monitors │ Search Control │ Admin        │
└───────────────┬───────────────────────┬─────────────────────────┘
                │                       │
       ┌────────▼────────┐      ┌──────▼──────────────────┐
       │ PostgreSQL      │      │ Object Storage          │
       │ Control truth   │      │ Public Raw/Artifacts    │
       └─────────────────┘      └─────────────────────────┘
                │
        outbound claim/heartbeat/result
        ┌───────┴────────────────────────────────┐
        │                                        │
┌───────▼──────────────┐               ┌─────────▼───────────────┐
│ Public Cloud Workers │               │ Private Workers         │
│ public web           │               │ user device / VPC       │
│ anonymous browser    │               │ auth profile / intranet │
│ cloud artifact upload│               │ local SQLite + local CAS│
└──────────────────────┘               └─────────────────────────┘
```

## 8. 部署 Profile

### 8.1 Local Free

- 当前 CLI/MCP 保持工作。
- 单用户、单数据目录、SQLite。
- 不要求云端账号。
- 授权 Profile 和本地索引保留在设备。

### 8.2 Cloud Self-Serve

- Web、REST、云 MCP。
- 公开网页由公共 Worker 执行。
- Project 级 API Key、额度、结果和 Monitor。
- 不接受用户浏览器 Profile 上传。

### 8.3 Hybrid Pro

- 云端控制面。
- 本机 Companion 主动连接云端。
- 公开任务可选云端；授权任务固定到 Companion。
- 私有正文默认只在本机。

### 8.4 Enterprise Private Worker

- 控制面仍可由平台托管。
- Worker 位于客户 VPC。
- 内网目标和企业凭证不出 VPC。
- 企业可选择只上传元数据和内容 Hash。

### 8.5 Full Private Deployment

状态：`Conditional`。

只有出现付费客户、数据边界要求和交付预算后，才提供完整控制面私有部署。第一版不维护第二套独立
产品分支。

## 9. 控制面组件

控制面先作为模块化单体部署，各模块只能通过显式服务接口访问其他模块的数据。

| 模块 | 拥有的数据 | 主要职责 |
|---|---|---|
| Identity | User、Session、OIDC subject | 登录会话和主体解析 |
| Organization | Organization、Membership | 最小 owner/admin/member 关系 |
| Project | Project、Policy | 数据隔离、默认执行和保留策略 |
| Credential | API Key、Webhook Secret 引用 | 哈希、轮换、撤销 |
| Job | Job、Event、Publication | 任务合同、状态机、cursor |
| Routing | Placement、eligible Worker | 公共/私有放置与能力匹配 |
| Worker | Worker、Key、Session、Lease | 注册、claim、heartbeat、fencing |
| Artifact | Metadata、object reference | Artifact 发布、下载和删除 |
| Monitor | Schedule、next run | 创建周期性 Job，不直接抓取 |
| Usage | append-only ledger | 配额、成本代理、质量投影 |
| Audit | append-only event | 安全和管理操作证据 |
| Webhook | Endpoint、Delivery | 签名投递、重试、dead letter |

禁止控制面直接引用 Browser Profile 文件、Cookie 或私有网页正文。

## 10. 租户与权限模型

### 10.1 所有权

```text
User
  └── Organization
        └── Project
              ├── API Key
              ├── Worker
              ├── Job / Monitor
              ├── Artifact
              └── Usage / Audit
```

Project 是最小数据隔离、配额和计费边界。

### 10.2 角色

| 角色 | 权限 |
|---|---|
| owner | 账单、组织删除、成员、Project 和全部资源 |
| admin | Project、Worker、API Key、任务和审计 |
| member | 创建任务、读取允许的结果、管理自己的 Monitor |

不实现自定义角色。个人用户注册后自动拥有一个 personal Organization 和默认 Project。

### 10.3 授权不变量

- 请求正文中的 `organization_id` 或 `project_id` 不能覆盖认证主体的 Scope。
- Repository 方法必须显式接收 `ProjectScope`。
- 业务表直接包含 `project_id`，不通过多层 Join 间接推导租户。
- 跨 Project 资源统一返回 404，避免泄露资源存在性。
- 被撤销主体不能继续 claim、上传、下载或触发 Webhook。

## 11. 身份与密钥

### 11.1 人类用户

- 标准 OIDC Authorization Code + PKCE。
- 访问令牌有效期建议 10 分钟。
- Refresh Token 单次使用并轮换。
- Refresh Token 使用 `Secure`、`HttpOnly`、`SameSite` Cookie。
- 浏览器不得把长期 Token 放入 `localStorage`。
- JWT 固定校验算法、issuer、audience、expiration 和 `jti`。
- Refresh Token 重用触发该用户全部会话撤销和安全审计。

### 11.2 API Key

API Key 属于 Project，原始 Secret 只显示一次，数据库只保存密码学 Hash、前缀、创建人、到期和撤销
时间。

第一版权限固定为：

- `tasks:write`
- `results:read`
- `project:admin`

### 11.3 Worker Enrollment

1. 管理员创建十分钟有效的一次性 Enrollment Token。
2. Worker 本地生成 Ed25519 密钥对。
3. Worker 上传公钥、版本和 capability manifest。
4. 控制面绑定 Worker、Project 和公钥。
5. Enrollment Token 立即失效。
6. Worker 私钥保存在系统 Keychain 或 mode-0600 文件，不上传。

### 11.4 Worker Session

Worker 用私钥签名服务端 challenge，换取短期 Worker Session Token。Token 固定 audience、Worker ID、
Project ID 和 capability hash。

### 11.5 Webhook

- 每个 Endpoint 使用独立 Secret。
- 请求以 timestamp、delivery ID 和 body hash 做 HMAC。
- Secret 支持并行轮换窗口。
- 重放窗口建议五分钟。

## 12. 数据分类与执行位置

| 数据分类 | 默认 Worker | 正文位置 | 云端允许保存 |
|---|---|---|---|
| public | 公共或私有 | 云端或本地 | 是 |
| authorized | 指定私有 | 本地 | 仅单 Job 明确批准 |
| intranet | 企业私有 | 客户 VPC | 默认否 |

强制规则：

- 私有 Worker 离线不能把 authorized/intranet Job 改派公共 Worker。
- Job 创建后数据分类只能收紧，不能在重试时放宽。
- Cookie、Profile、Authorization Header、代理凭证和私钥永不进入普通 Job payload。
- 私有 Job 默认只上传状态、错误码、Hash、字节数、时延和脱敏用量。
- 私有正文上传批准只绑定一个 Job，不提供永久全局开关。

## 13. Job 合同

### 13.1 Job 类型

- `read`
- `inspect`
- `map`
- `crawl`
- `search`
- `monitor-run`
- `vertical-index-run`

### 13.2 Job Envelope

```json
{
  "jobId": "uuid",
  "projectId": "uuid",
  "type": "crawl",
  "input": {},
  "placement": {
    "class": "public",
    "pinnedWorkerId": null
  },
  "budget": {
    "deadlineMs": 300000,
    "maxProviderAttempts": 100,
    "maxDocumentBytes": 50000000,
    "maxBrowserMs": 120000,
    "maxBrowserContexts": 20
  },
  "policyVersion": "sha256:...",
  "uploadPrivateArtifact": false,
  "createdAt": "RFC3339",
  "envelopeHash": "sha256:..."
}
```

控制面冻结 Job Envelope；Worker 不得修改预算、placement、数据分类或上传权限。

### 13.3 Job 状态机

```text
accepted
  -> queued
  -> assigned
  -> running
  -> completed | failed | cancelled

queued | assigned | running
  -> paused
paused
  -> queued | cancelled

assigned
  -> queued           lease 过期；仍受原 placement 约束
```

`completed` 只表示任务终局。结果另有 `complete` 或 `partial` outcome，避免把部分成功伪装成完整成功。

### 13.4 Lease 与 fencing

- Claim 在事务中选择 eligible Job 并创建 Lease。
- Lease 包含 owner、generation、deadline 和 heartbeat deadline。
- 每次重新 claim 增加 generation。
- 旧 generation 的 heartbeat、event、publication 和 complete 全部拒绝。
- Worker 定期 heartbeat；控制面不根据 TCP 连接推断任务存活。
- 私有 Job lease 过期后仍只允许原私有 Worker 或同一 Project 明确允许的私有 Worker。

### 13.5 交付语义

- Job 分发为 at-least-once。
- Publication 通过 `job_id + sequence` 唯一约束实现幂等。
- POST 创建使用 `Idempotency-Key`。
- 相同 Project 和幂等键重复请求返回原 Job。
- 相同幂等键但 payload hash 不同返回 409。
- Worker event 使用 `lease_id + local_sequence` 去重。

## 14. Worker Claim 协议

### 14.1 传输

第一版使用 Worker 主动 HTTPS long-poll：

1. Worker 创建短期 Session。
2. 调用 claim，声明 capability hash 和最多等待 30 秒。
3. 控制面事务选择 eligible Job。
4. 返回 Job Envelope 和 Lease。
5. Worker heartbeat、追加 event/publication。
6. Worker提交 terminal。

不要求私有网络开放入站端口。WebSocket 只有在真实延迟数据证明 long-poll 不足时再评估。

### 14.2 Capability Manifest

包含：

- Runtime version。
- HTTP/Browser/PDF/Feed capability。
- Chrome channel/version。
- 最大并发和资源边界。
- 支持的数据分类。
- 可达网络类别：public 或 intranet。
- Policy/Extractor/Validator version。

控制面只向满足全部 capability 的 Worker 分发 Job。

### 14.3 Worker 离线

- 心跳超时把 Worker 标为 unavailable。
- 不取消已提交 publication。
- 活跃 Lease 到期后按 placement 重新排队。
- 私有固定 Job 保持等待，不降级到公共 Worker。
- Monitor 因 Worker 离线失败时保留上次成功基线。

## 15. 公共 REST API

### 15.1 设计原则

- Contract-first，先提交 OpenAPI，再实现。
- 路径版本固定为 `/v1`。
- POST 创建要求 `Idempotency-Key`。
- 列表使用 opaque cursor，不使用 offset。
- 错误使用 RFC 7807 Problem Details。
- 所有响应包含 `request_id`；异步资源包含 `job_id`。

### 15.2 最小端点

```text
POST   /v1/projects/{project_id}/jobs
GET    /v1/projects/{project_id}/jobs/{job_id}
POST   /v1/projects/{project_id}/jobs/{job_id}/pause
POST   /v1/projects/{project_id}/jobs/{job_id}/resume
POST   /v1/projects/{project_id}/jobs/{job_id}/cancel
GET    /v1/projects/{project_id}/jobs/{job_id}/publications

POST   /v1/projects/{project_id}/monitors
GET    /v1/projects/{project_id}/monitors
GET    /v1/projects/{project_id}/monitors/{monitor_id}
DELETE /v1/projects/{project_id}/monitors/{monitor_id}

POST   /v1/projects/{project_id}/api-keys
GET    /v1/projects/{project_id}/api-keys
DELETE /v1/projects/{project_id}/api-keys/{key_id}

POST   /v1/projects/{project_id}/worker-enrollments
GET    /v1/projects/{project_id}/workers
POST   /v1/projects/{project_id}/workers/{worker_id}/disable

GET    /v1/projects/{project_id}/usage
GET    /v1/projects/{project_id}/audit-events

POST   /v1/projects/{project_id}/webhook-endpoints
GET    /v1/projects/{project_id}/webhook-endpoints
DELETE /v1/projects/{project_id}/webhook-endpoints/{endpoint_id}
```

### 15.3 Worker 内部端点

```text
POST /v1/worker-sessions/challenges
POST /v1/worker-sessions
POST /v1/workers/{worker_id}/claims
PATCH /v1/job-leases/{lease_id}
POST /v1/job-leases/{lease_id}/events
POST /v1/job-leases/{lease_id}/publications
POST /v1/job-leases/{lease_id}/complete
```

### 15.4 错误格式

```json
{
  "type": "https://api.diaoyan.example/errors/worker-unavailable",
  "title": "Worker unavailable",
  "status": 503,
  "detail": "The job requires its pinned private worker.",
  "instance": "/v1/projects/.../jobs/...",
  "code": "WORKER_UNAVAILABLE",
  "request_id": "uuid",
  "retryable": true
}
```

### 15.5 状态码

| 场景 | 状态 |
|---|---:|
| 创建 Job | 201 |
| 幂等重放 | 200 |
| 异步接受但尚未分配 | 202 |
| 无认证 | 401 |
| 权限不足 | 403 |
| 不存在或跨租户 | 404 |
| 幂等冲突/状态冲突 | 409 |
| 语义校验失败 | 422 |
| 配额或速率限制 | 429 |
| 固定私有 Worker 不可用 | 503 |

## 16. MCP 与 SDK

### 16.1 MCP

- 本地 MCP 保持 stdio。
- 云 MCP 作为 REST API 的薄适配器，不复制任务逻辑。
- MCP tool 的 `isError` 保持结构化错误。
- 长任务仍返回 Job ID，通过 cursor 获取 publication。

### 16.2 SDK

第一版提供 TypeScript SDK；Python SDK 在 OpenAPI 合同稳定后生成并人工补齐：

- API Key 认证。
- 自动 Idempotency-Key。
- cursor iterator。
- bounded wait。
- RFC 7807 typed errors。
- Webhook verification helper。

SDK 不自动无限重试。只对明确 retryable 且幂等的请求执行有界退避。

## 17. C 端产品面

### 17.1 Web 工作台

第一版页面：

1. 登录与 Onboarding。
2. Project 首页。
3. 单页读取。
4. Crawl 创建与进度。
5. Job 详情与 publication。
6. Monitor 列表与变化记录。
7. Artifact 查看、下载和证据。
8. Worker/Companion 状态。
9. 用量与预算。

### 17.2 Browser Extension

- 只获取当前 Tab URL 和用户明确选择的页面。
- 公开页面可发送云端。
- 授权页面必须路由本机 Companion。
- 不把 Cookie 复制到扩展后台或云端。
- 显示执行位置和上传边界。

### 17.3 Local Companion

- 注册为 private Worker。
- 管理专用授权 Profile。
- 显示正在运行的 Job、域名、预算和上传选择。
- 允许用户随时断开、撤销或清空本地数据。
- 自动升级必须签名并支持回滚。

## 18. B 端产品面

- Project 与 API Key。
- REST、MCP、SDK。
- 批量和耐久 Job。
- Webhook。
- 用量、预算和审计。
- Cloud/Private Worker routing。
- 导出和数据删除。

第一版不做 SSO、SCIM、自定义角色和复杂组织层级。

## 19. 云端数据模型

### 19.1 最小表

```text
users
organizations
organization_memberships
projects
refresh_tokens
api_keys
workers
worker_public_keys
worker_sessions
worker_enrollments
jobs
job_leases
job_events
job_publications
artifact_metadata
monitors
usage_ledger
audit_events
idempotency_records
webhook_endpoints
webhook_deliveries
```

### 19.2 通用字段

- 主键使用 UUID。
- 时间使用 TIMESTAMPTZ。
- Money 只在真实账单阶段加入，使用 NUMERIC，不使用 float。
- 状态使用 TEXT + CHECK。
- 高频查询字段使用普通列；JSONB 只保存版本化输入快照或低频扩展证据。

### 19.3 关键唯一约束

```text
organization_memberships(organization_id, user_id)
projects(organization_id, slug)
api_keys(key_hash)
workers(project_id, name)
jobs(project_id, idempotency_key)
job_leases(job_id, generation)
job_events(job_id, sequence)
job_publications(job_id, sequence)
webhook_deliveries(endpoint_id, event_id)
```

### 19.4 关键索引

```text
jobs(project_id, created_at DESC, id DESC)
jobs(status, not_before, priority, created_at)
jobs(pinned_worker_id, status, not_before)
job_leases(worker_id, heartbeat_deadline)
job_publications(job_id, sequence)
usage_ledger(project_id, occurred_at)
audit_events(project_id, occurred_at DESC, id DESC)
monitors(status, next_run_at)
webhook_deliveries(status, next_attempt_at)
```

### 19.5 Claim 事务

第一版不引入消息队列。控制面使用 PostgreSQL `FOR UPDATE SKIP LOCKED`：

1. 按 placement、capability、priority、not_before 选择 Job。
2. 锁定一行。
3. 创建或递增 Lease generation。
4. 更新 Job 为 assigned。
5. 同事务提交。

只有实测出现数据库 claim contention、不可接受延迟或跨区域需求时，才评估独立队列。

## 20. Artifact 与存储

### 20.1 权威边界

| 数据 | 权威存储 |
|---|---|
| Job/current state | PostgreSQL |
| Job events/publication metadata | PostgreSQL |
| 公共 Raw/Artifact bytes | 对象存储 |
| 私有 Raw/Artifact | 私有 Worker SQLite/CAS |
| 本地索引 | Worker SQLite FTS5 |
| 云端搜索投影 | 后续独立批准 |

### 20.2 对象命名

不同 Project 第一版不物理去重：

```text
organization/{org_id}/project/{project_id}/artifact/{artifact_id}/{version}
```

这避免通过内容 Hash 推断其他租户是否拥有同一内容。

### 20.3 下载

- API 先验证 ProjectScope。
- 返回短期签名下载 URL。
- URL 不包含源站凭证或原 URL 查询参数。
- 下载和导出写审计。

### 20.4 Retention

建议初始默认：

- Job/event/publication metadata：90 天。
- 公共 Artifact：30 天。
- Usage：13 个月。
- Audit：13 个月。
- 私有正文：由 Worker 本地策略决定。

最终值必须在隐私政策、成本试算和首批用户访谈后冻结。

## 21. Monitor 调度

- Monitor 只拥有 URL、周期、placement、预算和上次成功 Hash。
- Scheduler 在 PostgreSQL 中 claim 到期 Monitor 并创建普通 Job。
- 下次运行时间从上次 terminal 时间计算。
- 创建 Job 与更新 `next_run_at` 在同一事务。
- Monitor 失败不删除上次成功基线。
- pinned private Worker 离线时记录明确失败，不改派公共 Worker。
- Webhook 只由 terminal event 触发。

## 22. Webhook

### 22.1 事件

- `job.completed`
- `job.failed`
- `job.cancelled`
- `monitor.changed`
- `monitor.failed`
- `worker.offline`
- `budget.threshold_reached`

### 22.2 Delivery

- 每个 event 生成稳定 event ID。
- Delivery append-only。
- 2xx 成功；其他状态显式失败。
- 有界指数退避并尊重 Retry-After。
- 达到最大次数进入 dead-letter 状态。
- 用户可从同一 event 手动重投，产生新的 delivery ID。
- 不把正文默认放入 Webhook，只返回 ID、状态和短期读取入口。

## 23. 用量、配额和计费边界

### 23.1 Usage Ledger

每个 terminal Job 写 append-only Usage：

- provider attempts。
- document bytes。
- browser milliseconds。
- browser contexts。
- pages discovered/published。
- valid/uncertain/failed/policy_stop。
- retry delay。
- cloud/private placement。

### 23.2 第一版只做配额

- 每分钟 API 请求。
- 同时活动 Job。
- 每月 Provider attempts。
- 每月 Browser minutes。
- Artifact storage bytes。

超限返回 429 或 Job 级 `BUDGET_EXHAUSTED`，不能静默降级。

### 23.3 真实收费

状态：`Conditional`。

先用 Usage Ledger 和成本报告验证单位有效结果成本，再接入账单 Provider。不得先实现复杂套餐、优惠、
账单调整或自动网页许可付款。

## 24. 配置

### 24.1 控制面配置

- 数据库连接。
- 对象存储桶。
- OIDC issuer/client。
- Token signing key reference。
- Public Worker pool default。
- 全局安全上限。
- Webhook egress policy。

### 24.2 Project Policy

只保留真正改变产品行为的字段：

- 默认 placement。
- 是否允许公共 Worker。
- Job 并发上限。
- 月度资源预算。
- Artifact retention。

不把当前 Runtime 的所有内部调优项暴露为租户配置。

## 25. 部署拓扑

### 25.1 第一版生产拓扑

```text
Internet
  -> TLS Load Balancer
      -> 2 x Control API container
      -> 1 x Scheduler leader（同镜像、数据库 lease）

Managed PostgreSQL
Object Storage
Managed OIDC

Public Worker pool
  -> N x Worker container

Private Worker
  -> outbound HTTPS only
```

### 25.2 容器要求

- 多阶段构建。
- 非 root 用户。
- 只读根文件系统；数据目录显式挂载。
- 不把 Secret 写入镜像或构建参数。
- CPU、内存、临时空间和 Browser 进程限制。
- 镜像生成 SBOM、漏洞扫描和签名。

### 25.3 为什么第一版不用 Kubernetes

单区域、少量服务可以使用受管容器平台。只有出现以下证据之一才评估 Kubernetes：

- Worker 池规模和异构资源需要独立弹性调度。
- 多团队需要明确平台边界。
- 当前平台不能满足滚动发布、隔离或容量需求。
- 运维团队具备长期维护能力。

## 26. CI/CD

### 26.1 Pull Request Gate

并行执行：

- `pnpm check`。
- `pnpm build`。
- 快速单元/集成测试。
- 数据库迁移从空库创建。
- 前一版本 Schema 升级到新版本。
- OpenAPI lint 和 breaking-change 检查。
- Secret scan、SCA 和 SAST。
- 容器构建与非 root 检查。

重型 Chrome、SIGKILL 和规模 E2E 使用独立串行 Job，不能通过放宽测试规避资源争用。

### 26.2 Nightly

- 当前 HEAD 的公开 Canary。
- 真实 Chrome。
- Worker 断线恢复。
- Webhook 故障矩阵。
- 跨租户隔离矩阵。
- 数据库 backup/restore。
- Benchmark 报告绑定 Git SHA、镜像 digest、Schema version 和环境指纹。

报告进入持久 Artifact Storage；gitignored 本地文件不再作为唯一证据。

### 26.3 Release

- 只允许 main。
- 使用 CI OIDC 获取短期云权限，不保存静态云密钥。
- Staging 自动部署。
- Production 需要人工批准。
- 先部署控制面兼容 Schema，再滚动 Worker。
- 灰度 Project 通过后逐步放量。
- 失败可回滚镜像；数据库迁移必须提供前向恢复策略。

## 27. 数据库迁移

### 27.1 控制面

- Schema migration 文件不可修改。
- 每个 migration 有唯一版本和 checksum。
- CI 验证空库和从最近支持版本升级。
- Expand/contract 仅用于正在运行的云端版本切换，不保留长期双 Schema。
- 破坏性删除在所有运行实例升级后执行。

### 27.2 私有 Worker

当前旧 `crawl_jobs` 明确不支持迁移。混合产品发布前必须选择一个新的起始 Schema version：

1. 冻结 Worker v1 Schema。
2. 为以后每次变更提供真实 migration。
3. migration 前自动创建可验证备份。
4. migration 失败时不启动 Worker。
5. 不用“创建全新数据目录”作为正式用户升级方案。

## 28. 可观测性

### 28.1 Correlation

`request_id -> job_id -> lease_id -> worker_id -> attempt_id -> publication_sequence`

每层日志、Metric 和 Trace 都携带相应 ID，但不携带正文、Cookie、完整 URL 查询参数或 Secret。

### 28.2 指标

控制面：

- API request rate、error rate、p50/p95/p99。
- Job queue age、claim latency、terminal latency。
- active/expired lease。
- Worker online/offline 和版本分布。
- Webhook success/retry/dead-letter。
- PostgreSQL pool、lock、slow query。

执行面：

- valid artifact rate。
- false success。
- provider success/failure。
- browser uplift。
- retry recovery/waste。
- bytes、browser time、contexts。
- per-origin cooldown 和 circuit state。

### 28.3 日志

- JSON structured logs。
- stdout 只用于普通 HTTP 服务；MCP stdio 继续禁止 stdout 日志污染。
- Secret、Token、Cookie、Profile、正文和 URL 查询参数必须清理。
- 未知错误必须 error 并携带 request ID。

## 29. 候选 SLO

以下是进入试运行的候选值，不是已证明 SLA：

| 指标 | Canary 目标 |
|---|---:|
| Control API 可用性 | >= 99.5% |
| Job 创建 p95 | < 500 ms |
| 可用 Worker 下 claim p95 | < 5 s |
| publication 可见延迟 p95 | < 2 s |
| Webhook 首次投递 p95 | < 10 s |
| 跨租户数据泄露 | 0 |
| false success | 0 |
| committed publication 重抓 | 0 |
| Worker 断线后状态丢失 | 0 |

生产 SLA 必须由至少 30 天真实流量再冻结。

## 30. 备份与灾难恢复

### 30.1 PostgreSQL

- 每日全量 + 持续 WAL/PITR。
- 每月至少一次恢复演练。
- 恢复到隔离环境，先做完整性和租户抽样验证。
- 记录 RPO/RTO 实测值。

### 30.2 对象存储

- 开启版本化。
- 生命周期规则与 Artifact retention 一致。
- 删除先写 tombstone，再异步删除对象。
- 数据库 metadata 与对象清理有可重放 reconciliation。

### 30.3 私有 Worker

- 复用安全 SQLite online backup。
- Companion 提供导出、验证和恢复命令。
- 恢复到新路径，不覆盖运行中的数据库。

## 31. 安全边界

- 所有外部 URL 继续经过 SSRF、DNS、redirect、robots 和 RSL。
- 云端 Worker egress 采用 deny private ranges。
- 私有 Worker 只有明确 intranet Project 才允许企业内网目标。
- API、Worker 和 Webhook 采用独立密钥。
- 用户内容不能进入控制日志或分析系统。
- Artifact 下载必须重新授权，不能依赖不可过期 URL。
- 生产 Secret 使用 Secret Manager/KMS 引用。
- CI/CD 使用 OIDC 短期凭证。
- 容器非 root、默认无额外 Linux capabilities。
- Auth、支付、Secret、Worker enrollment 和私有上传必须人工安全审查。

## 32. 测试策略

### 32.1 TDD

每个阶段：

1. 冻结输入、输出、错误和安全边界。
2. 先写因缺少行为而失败的测试。
3. 保存 RED 原因。
4. 最小实现。
5. 聚焦测试。
6. 受影响回归。
7. 全量和真实环境 Gate。

禁止修改断言、跳过 flaky 测试或只用 Mock 证明数据库、网络和进程行为。

### 32.2 测试层次

| 层 | 重点 |
|---|---|
| Unit | 状态机、路由、预算、签名、权限、错误映射 |
| Integration | 真实 PostgreSQL、对象存储兼容服务、OIDC test issuer |
| Contract | OpenAPI、SDK、MCP、Worker protocol、Webhook |
| E2E | Web/API -> Control -> Worker -> Artifact -> Webhook |
| Fault | kill、lease expiry、DB restart、object failure、network partition |
| Security | 跨租户、Token reuse、key revoke、SSRF、secret redaction |
| Benchmark | Truth、false success、cost per valid artifact |

### 32.3 必测隔离矩阵

- User A 不能读 Project B。
- API Key A 不能写 Project B。
- Worker A 不能 claim Project B。
- Lease A 不能提交 Job B。
- 签名 URL A 不能下载 Artifact B。
- Webhook A 不能收到 Project B event。
- 删除/撤销后所有旧 Credential 失效。

### 32.4 测试原则

- 数据库集成使用真实 PostgreSQL，不 Mock SQL 行为。
- 文件测试使用临时目录。
- 时间通过注入 Clock 控制。
- 异步等待使用条件和 deadline，不使用固定 sleep。
- 外部站点只用于 Nightly Canary；PR 使用受控站点。
- 关键状态机使用属性测试验证非法转换和幂等。

## 33. 7 天稳定性试验

### 33.1 前置条件

- 当前 HEAD Nightly 通过。
- Staging 与生产候选镜像 digest 固定。
- 数据库、对象存储和 Worker 指标可见。
- 自动备份和告警启用。

### 33.2 工作负载

每天执行：

- 公开 read。
- 静态与动态 crawl。
- Monitor。
- SearXNG discovery。
- 公共和私有 Worker。
- Worker restart、网络断开和 Chrome restart。
- Webhook 成功、429、500 和超时。

### 33.3 通过条件

- 连续 7 天无人工修数据库或重置状态。
- 无跨租户事件。
- 无 false success。
- committed publication 不重抓。
- 队列最终清空或失败显式。
- 备份可以恢复。
- 所有错误可由 request/job/lease ID 追踪。
- 资源增长趋势有界。

## 34. 300,000 页压力测试

### 34.1 目标

验证 300,000 页不仅是 CHECK 上限，而是可运行容量。

### 34.2 场景

1. 批量写入 300,000 个不同 final URL。
2. 混合新页面和已有页面更新。
3. 查询并发与 Crawl publication 并发。
4. 生成历史版本和内容 Hash。
5. 触发 FTS rebuild。
6. 创建 release、校验、activate 和 rollback。
7. 执行 online backup 和隔离恢复。
8. 进程 kill/restart。

### 34.3 记录

- 总耗时和吞吐。
- CPU、RSS、磁盘、WAL。
- 数据库锁等待。
- FTS 查询 p50/p95/p99。
- rebuild、release、backup、restore 耗时。
- Worker claim 和 publication 延迟。
- 数据库完整性。

### 34.4 通过门槛

具体延迟门槛先由 10k/50k/100k 基线确定；不得在测试后倒推一个必过阈值。硬性条件：

- 无数据丢失或重复 publication。
- `PRAGMA integrity_check = ok` 或 PostgreSQL 等价完整性检查通过。
- 满容量拒绝新 URL，已有 URL 可更新。
- kill/restart 后可以继续。
- backup/restore 内容可验证。

## 35. 发布门槛

### 35.1 Experimental

- 单元和聚焦集成通过。
- 不对外开放真实用户。

### 35.2 Canary-ready

- 当前 Git SHA 的 PR/Nightly Benchmark 通过。
- Staging E2E、跨租户和安全矩阵通过。
- 7 天试验至少在内部 Project 通过。

### 35.3 Release-candidate

- 私有 Release Corpus。
- 公共与私有 Worker 真实用户试用。
- 300,000 页压力证据。
- 备份恢复和回滚演练。
- 支持和事故流程明确。

### 35.4 Production-proven

- 至少 30 天生产流量。
- SLO、成本和容量趋势稳定。
- 已发生故障有复盘和改进证据。
- 不以测试数据冒充生产证明。

## 36. 分阶段实施计划

### Phase 0：刷新证据

目标：让当前 HEAD 的完成声明重新可验证。

任务：

- 运行 PR 和 Nightly Benchmark。
- 把报告绑定 Git SHA、环境、case hash 和镜像 digest。
- 建立持久报告存储。
- 补充 CI 基础 Gate。

完成条件：

- fresh check/build/test/Nightly 通过。
- 报告不再只存在 gitignored 本地目录。

### Phase 1：冻结协议

目标：先定义云端与现有 Runtime 的最小接口。

任务：

- 新建 OpenAPI。
- 定义 Job Envelope、Lease、Event、Publication、Usage。
- 定义错误码、幂等键和 cursor。
- 定义 Worker capability 和数据分类。
- 增加合同测试，先获得 RED。

完成条件：

- 合同可以表达现有 read/crawl/monitor。
- 不修改抓取算法。

### Phase 2：最小控制面

目标：单 Project、API Key、PostgreSQL Job 和 Worker claim 闭环。

任务：

- Project、API Key、Job、Lease、Event、Publication Schema。
- REST 创建/查询/cancel/publications。
- PostgreSQL claim。
- Worker enrollment/session。
- append-only audit/usage 首版。

完成条件：

- 一个 API Key 可提交公开 Job。
- 一个远程 Worker 可 claim 并发布结果。
- kill/restart 不丢状态。

### Phase 3：私有 Worker

目标：授权和内网任务不离开设备。

任务：

- Local Companion enrollment。
- pinned placement。
- 本地 Profile 路由。
- metadata-only 默认返回。
- 单 Job 私有 Artifact 上传批准。
- Worker offline/revoke/rotate。

完成条件：

- 网络抓包和存储审计证明 Cookie/Profile/正文默认未上传。
- 离线不改派公共 Worker。

### Phase 4：公共云 Worker 与 Artifact

目标：公开网页形成云端自助服务。

任务：

- Public Worker pool。
- Object Artifact Store。
- 签名下载。
- retention 和删除。
- 资源 quota。

完成条件：

- 公开 read/crawl/monitor E2E。
- Artifact 所有权和跨租户测试通过。

### Phase 5：B 端交付

目标：外部开发者可以稳定接入。

任务：

- 完整 REST v1。
- 云 MCP Gateway。
- TypeScript SDK。
- Webhook。
- 用量、预算和审计查询。
- API 文档和示例。

完成条件：

- 示例应用只使用公开合同完成 read/crawl/monitor。
- Idempotency、cursor、Webhook 重试通过真实 E2E。

### Phase 6：C 端交付

目标：非开发者可以使用。

任务：

- Web 工作台。
- Browser Extension。
- Companion 安装和状态页。
- Project、Artifact、Monitor 体验。
- 导出与删除。

完成条件：

- 新用户无需 CLI 完成公开读取。
- 授权页面明确路由本机并显示数据边界。

### Phase 7：运营闭环

目标：系统可以无人值守运行。

任务：

- CI/CD、镜像签名、受保护生产环境。
- Dashboard、alert、runbook。
- PostgreSQL/object backup 和 restore。
- Schema migration。
- incident、support、status page。

完成条件：

- 7 天试验通过。
- 故障注入和恢复演练通过。

### Phase 8：规模与 Release

目标：用真实证据决定是否发布。

任务：

- 300,000 页压力测试。
- 私有 Release Corpus。
- 竞品同 Corpus 对照。
- 小规模付费试用。
- 成本和 SLO 评估。

完成条件：

- 达到 release-candidate。
- 明确 adopt/adapt/build 的下一轮决策。

### Phase 9：条件式扩展

只有触发后再评估：

- SSO/SCIM/RBAC。
- 完整私有部署。
- 独立消息队列。
- Kubernetes。
- embedding/vector/reranker。
- 自有开放 Web 数据层。
- 正式账单和发票。

## 37. 建议仓库演进

第一阶段不立即重构 monorepo。优先最小新增：

```text
openapi/
  diaoyan-control-v1.yaml

src/control/
  identity/
  projects/
  jobs/
  workers/
  usage/
  audit/
  webhooks/

src/remote-worker/
  client.ts
  enrollment.ts
  claim-loop.ts

migrations/
tests/control/
tests/e2e/hybrid/
```

Web 产品进入 Phase 6 后，再根据构建和发布边界决定是否转为 workspace。不得为了目录美观提前拆包。

## 38. 风险登记

| 风险 | 早期信号 | 处理 |
|---|---|---|
| 控制面挤占抓取核心 | 大量账号功能、无真实 Job | 每阶段必须以有效结果闭环验收 |
| 私有数据误上传 | payload 出现正文/Profile | 默认 metadata-only，真实抓包测试 |
| PostgreSQL claim contention | lock wait、claim p95 上升 | 先优化索引/事务，再评估队列 |
| SQLite 300k 性能不足 | WAL/RSS/查询 p95 上升 | 分段基线，按证据改存储 |
| Browser 成本失控 | browser uplift 低、分钟上涨 | Planner Gate 和 Project budget |
| API 合同漂移 | MCP/Web/SDK 结果不同 | OpenAPI + parity contract |
| Worker 版本碎片 | capability/version 分布发散 | 最低支持版本和升级窗口 |
| flaky E2E | 重跑才能通过 | 修复时序，不放宽断言 |
| 文档夸大成熟度 | Planned 被写成 implemented | 状态标签和 release evidence |
| 过早平台化 | Kafka/K8s/SSO 提前出现 | Conditional Gate |

## 39. 需要形成的后续 ADR

实施前按顺序完成：

1. Control Plane Boundary ADR。
2. Job/Worker Protocol ADR。
3. Tenant and Data Classification ADR。
4. PostgreSQL Schema and Claim ADR。
5. Artifact Storage and Retention ADR。
6. Identity/API Key/Worker Key ADR。
7. Webhook Delivery ADR。
8. Deployment and Release ADR。
9. 7-day Soak Specification。
10. 300k Capacity Benchmark Specification。

每份 ADR 必须记录批准边界、拒绝方案、失败语义、测试和量化触发条件。

## 40. 总完成清单

勾选项以当前仓库代码和测试为证据；未勾选项仍未完成或只完成一部分。

- [ ] 当前 HEAD 的 Nightly 证据。
- [x] OpenAPI v1。`project-control-api.openapi.yaml`、`worker-control-api.openapi.yaml`（1.0.0），`control-plane-openapi-parity.test.ts`。
- [x] Project/API Key。`api-key-service.ts`、`project-api-key-http-api.ts`，迁移 0002。
- [x] Worker enrollment/session。`worker-bootstrap-http-api.ts`、`remote-worker/enrollment.ts`，迁移 0004。
- [x] PostgreSQL Job/Lease/Event/Publication。迁移 0005–0007，`control-plane-job-postgres*.integration.test.ts`。
- [ ] Remote Worker claim/heartbeat/terminal。已有 `remote-worker/client.ts`、`outbox.ts` 和 `job-lease-recovery.ts` 协议原语；尚无生产 claim/heartbeat/执行/terminal 编排循环。
- [ ] Public cloud Worker。
- [ ] Private Worker 数据边界。
- [ ] Artifact Store。
- [ ] REST/MCP/TypeScript SDK。REST（OpenAPI v1）与 TypeScript SDK（`src/sdk/client.ts`，`docs/sdk.md`）已完成；云 MCP 适配器未实现。
- [ ] Webhook。
- [ ] C 端 Web/Extension/Companion。
- [ ] Usage/Quota/Audit。Audit 已完成（迁移 0007、`/projects/{id}/audit-events`）；Usage/Quota 未实现。
- [ ] CI/CD 和受保护发布。CI 已完成（`.github/workflows/ci.yml`）；受保护发布未实现。
- [x] Schema migration。`migrations/control-plane/`，启动时 `runControlPlaneMigrations`，`control-plane-migrations.test.ts`。
- [ ] Backup/restore。本地 SQLite 已完成（`crawlume backup`/`restore`，见 `operations.md`）；PostgreSQL 依赖数据库自身方案，未做演练。
- [ ] 7 天稳定性试验。运行器与通过条件见 `soak-capacity-spec.md`；尚无 7 天运行证据。
- [ ] 300,000 页压力测试。运行器见 `soak-capacity-spec.md`；尚无完整运行证据。
- [ ] 私有 Release Corpus。
- [ ] 灰度和回滚。

## 41. 最终判断

方案 C 的关键不是先建设一个庞大的企业控制面，而是保留 Diaoyan 已有的可靠执行内核，在其外部增加
最小、可验证的交付层：

```text
统一任务合同
  + 可证明的数据隔离
  + 公共/私有 Worker 路由
  + 可追溯结果和成本
  + 可恢复的生产运行
```

只有这些闭环在真实用户、7 天试验和 300,000 页压力测试中成立，才进入账单、SSO、Kubernetes、
语义检索或开放 Web 等下一阶段。
