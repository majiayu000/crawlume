# 控制面租户与私有数据边界 ADR

状态：Accepted；租户、身份、Job、Lease、结果元数据与 Worker HTTP 合同已实现

日期：2026-09-01

关联文档：[技术选型与目标架构](./technology-selection-rfc.md)、
[已实现合同](./spec.md)

## 1. 决策

Diaoyan 采用云端控制面与本地或私有 Worker 分离的渐进式架构。

- `Project` 是任务、Worker、API Key、Artifact 元数据、Monitor 和用量的最小隔离边界。
- 控制面从已经认证的主体和成员关系解析 `ProjectScope`。业务请求不得自行声明或覆盖
  `organization_id`。
- 控制面 Repository 必须显式接收 `ProjectScope`，不得提供脱离租户条件的业务资源
  `findById(id)`。
- 用户授权页面和企业内网页面的正文默认只保存在执行该任务的私有 Worker。本地 Cookie、浏览器
  Profile、Authorization Header 和 Worker 私钥不进入控制面。
- 私有结果上传授权必须绑定一个明确的 Job；不提供永久全局上传开关。

现有 SQLite Retrieval Runtime 继续作为本地 Worker 数据面。控制面租户表使用 PostgreSQL，不能
为了复用现有 SQLite 表而把私有正文迁入云端。

## 2. 所有权模型

控制面采用以下固定层级：

```text
User -> Organization -> Project -> business resources
```

基础数据模型由 `users`、`organizations`、`organization_memberships` 和 `projects` 四张表组成。
它们定义租户边界，本身不是归属于 Project 的业务资源；后续 Job、Worker、API Key、Artifact、
Monitor 和 Usage 表必须直接包含 `project_id`。

第一版角色只有 `owner`、`admin` 和 `member`。自定义角色、部门、权限组和资源级 ACL 不在当前范围。
“组织始终保留至少一个 owner”由成员管理事务锁定 Organization 后检查并测试，不能只依赖单行
数据库约束。每次成员或 Project 写入都会在同一事务中重新读取操作者的当前角色，避免使用已经撤销
或降级的旧作用域继续写入。

## 3. 可信作用域

`ProjectScope` 只能通过以下输入解析：

1. 身份认证层提供的内部 `user_id`。
2. 路由或 API Key 指定的目标 `project_id`。
3. 控制面数据库中 Project 与 Organization Membership 的匹配记录。

解析失败统一返回访问拒绝，不区分 Project 不存在和用户不是成员，避免通过错误差异枚举 Project。
解析结果固定携带 `projectId`、`organizationId` 和组织角色。下游代码不能使用 Worker 或请求正文
上报的 Project ID 替换它。

## 4. 本切片

本切片实现：

- PostgreSQL 租户基础 migration。
- 不可由普通对象直接构造的 `ProjectScope` 合同。
- 参数化的成员关系解析查询。
- 未授权 Project、伪造 Organization ID 和跨 Project 读取的负向测试。

第一个切片不实现 OIDC、API Key、Worker Enrollment、Job、Artifact、账单、延迟删除或 PostgreSQL RLS。
这些能力按独立切片加入，不能改变本 ADR 的两项核心边界。

第二个切片实现固定三角色的成员新增、角色变更、成员移除和 Project 创建事务。owner 变更通过
Organization 行锁串行化；最后一个 owner 不能被降级或移除。成员邀请投递、Project 删除和审计事件
仍由后续切片实现，当前服务尚未连接公开 API。

第三个切片实现 Project API Key 的创建、认证、固定 scope 检查和撤销。Key 使用 32 字节随机 Secret，
完整值只在创建结果中出现；PostgreSQL 仅保存 SHA-256 Hash 和可显示前缀。认证查询原子检查过期与
撤销状态并更新最后使用时间。轮换采用“创建新 Key、切换调用方、撤销旧 Key”的显式流程，不增加
隐藏兼容窗口。

第四个切片实现 OIDC Authorization Code + PKCE、一次性 state/nonce、首次登录自动创建个人
Organization 和默认 Project、十分钟 EdDSA Access Token，以及三十天绝对期限的单次 Refresh Token
family。Refresh Token 重用在同一事务中撤销该用户全部 family，Access Token 验证同步检查 family
仍然活跃。HTTP 适配层后续必须把 Refresh Token 写入 `Secure`、`HttpOnly`、`SameSite` Cookie，且
不得写入 `localStorage`。

第五个切片实现 Project 管理员创建的十分钟一次性 Worker Enrollment Token、Ed25519 公钥注册、
两分钟一次性 challenge 和五分钟 Worker Session Token。Enrollment Token 与 challenge 在 PostgreSQL
中只保存 SHA-256 Hash；Session Token 固定绑定 Worker ID、Project ID、audience 和 capability hash。
Worker 被禁用后，其公钥和全部 Session 在同一事务中撤销。Worker 注册和换取 Session 的输入均不接受
Project ID，因此 Worker 上报值不能覆盖控制面根据 Enrollment 或 Worker 身份确定的 Project。

Worker Key 轮换、HTTP long-poll、Job claim、heartbeat 和审计事件不在本切片实现。

第六个切片实现冻结的 Job Envelope、Project 内幂等创建、显式状态转换，以及 PostgreSQL
`FOR UPDATE SKIP LOCKED` Worker claim。Lease 使用单调递增 generation、三十秒 heartbeat deadline 和
Job 最终 deadline；旧 generation 的 heartbeat 与 terminal 提交明确失败。断线产生的过期 Lease 只会
让 Job 在原 Project、数据分类、placement、pinned Worker 和 capability 条件下重新排队，不会放宽为
公共执行。私有 placement 只允许 `kind = private` 的 Worker。

本切片只提交 Job 与 Lease 合同；Job Event、Publication、Artifact、HTTP long-poll 和退避策略留给
后续独立切片。

第七个切片实现 append-only Job Event、幂等 Publication 和 Artifact 元数据。Worker 的每次提交都
同时绑定已认证 Session、Project、Worker、Lease 和 generation；事件与 Publication 分别使用 Worker
本地序号作为幂等键，同序号同内容返回原记录，同序号不同内容明确冲突。Job 行锁串行化同一 Job 的
控制面 sequence 分配，数据库组合外键继续拒绝跨 Project、跨 Worker 或旧 generation 写入。

结果提交合同只接受状态、错误码、Provider、字节数、耗时、内容 Hash、脱敏用量和 Artifact 元数据，
不接受正文、Cookie、Authorization Header、源站地址或 Worker 指定的对象路径。私有 Job 默认只能
登记 `worker_local` Artifact；只有该 Job 的 `upload_private_artifact` 为 true 时才能登记云端对象，
且对象路径由控制面按 Organization、Project、Artifact 和 version 生成。实际对象上传、签名下载 URL、
HTTP 端点、审计和保留期执行留给后续切片。

第八个切片定义 `/v1` Worker 内部 HTTP 合同和框架无关的请求处理器，覆盖 claim、heartbeat、Event、
Publication 与 complete。每个请求只接受短期 Worker Session Bearer Token；Worker 与 Project 从固定
算法、issuer、audience 和数据库状态均已验证的 Token 得出。路径中的 Worker ID 只能与 Token 主体做
一致性校验，正文没有 Project ID。claim 支持零至三十秒的有界长轮询，无任务时返回 204。协议错误
统一使用 RFC 7807 Problem Details，响应只携带控制面生成的 request ID，不回显 Token。

本切片不把控制面监听器装入现有本地 MCP 进程，也不增加部署依赖。TLS 终止、请求体字节上限、连接
取消传播和实际 HTTP Server 装配由控制面部署入口负责；这不会改变本切片的认证、fencing 和私有正文
边界。

第九个切片提供独立的 Worker Control Server 启动函数，但保持现有 MCP `main` 不变。远程地址必须
使用 TLS 1.2 或更高版本并由运行时注入证书；明文模式只允许精确 loopback 地址，适用于本机测试或
同机 TLS Proxy。请求正文上限固定为 64 KiB，Header 上限为 16 KiB，并设置十秒 Header/正文接收
超时。压缩正文、重复关键 Header、query、非法 UTF-8/JSON 和超限正文都会在进入 Worker API 前明确
失败。客户端断开和 Server 关闭会触发 AbortSignal，停止尚未完成的 claim 长轮询。

证书、私钥和数据库凭证不进入配置文件、镜像或日志；部署必须通过运行时 Secret 注入。负载均衡器
终止 TLS 时，跨主机后端连接仍需 TLS 重加密，除非 Proxy 与控制面共享 loopback 网络边界。

第十个切片把 Worker Control Server 接入真实 PostgreSQL 连接池并提供 `start:control-plane` 独立启动
入口。启动要求运行时注入数据库 URL、Worker Session Ed25519 私钥/公钥路径及 issuer/audience；远程
PostgreSQL 固定启用证书校验，可选注入 CA 文件，loopback PostgreSQL 才允许明文。数据库连接串禁止
携带会覆盖显式 TLS 配置的 SSL 参数。私钥文件拒绝符号链接和 group/other 权限。进程先执行只读
`SELECT 1` 探活，成功后才监听 Worker API；启动不自动执行 migration。

启动命令为 `pnpm build && pnpm start:control-plane`。必填运行时变量为
`DIAOYAN_CONTROL_DATABASE_URL`、`DIAOYAN_WORKER_SESSION_ISSUER`、
`DIAOYAN_WORKER_SESSION_AUDIENCE`、`DIAOYAN_WORKER_SESSION_PRIVATE_KEY_PATH` 和
`DIAOYAN_WORKER_SESSION_PUBLIC_KEY_PATH`。监听地址和端口默认是 `127.0.0.1:8787`；绑定远程地址时
必须同时提供 `DIAOYAN_CONTROL_TLS_KEY_PATH` 与 `DIAOYAN_CONTROL_TLS_CERT_PATH`。私有 CA 通过
`DIAOYAN_CONTROL_DATABASE_CA_PATH` 注入。私钥文件权限必须为 `0600` 或更严格。

第十一个切片增加 Project 级 append-only 审计表和读写合同。事件固定保存 Organization、Project、
主体类型与 ID、动作、目标、结果、时间和 correlation ID，不提供自由 JSON 字段，因此普通调用方不能
把 Token、Cookie、正文或请求参数塞入审计证据。数据库触发器拒绝 UPDATE、DELETE 和 TRUNCATE，
并提供 `(project_id, occurred_at DESC, id DESC)` cursor 索引。审计读取会在事务内重新校验当前 owner
或 admin 成员关系，member 不能读取。

本切片先把成员新增、角色修改、成员移除和 Project 创建与审计 INSERT 放进同一个事务；审计写入
失败会回滚管理变更。登录/登出、API Key、Worker、私有 Job、Artifact、Monitor、配额和账单事件仍需
在对应可信入口获得真实 correlation ID 后逐项接入，不能由业务正文自报主体或 Project。

第十二个切片接入 API Key 和 Worker 身份生命周期审计。API Key 创建、成功使用与撤销分别记录
`api_key.created`、`api_key.used` 和 `api_key.revoked`；更新 `last_used_at` 与使用审计在同一事务。
审计只保存 Key ID，不保存显示前缀、Hash 或原始 Secret。格式错误、未知、过期和已撤销 Key 继续返回
同一种认证失败，不能为了写 Project 审计而泄露 Key 是否存在。

Worker Enrollment 请求、成功注册和禁用分别记录 `worker.enrollment_created`、`worker.enrolled` 与
`worker.disabled`。注册事件的 Organization 和 Project 由已消费 Enrollment 关联 Project 得出，Worker
提交的正文仍不能指定租户。禁用 Worker、撤销公钥与 Session、写入审计在同一事务。Worker Key 轮换
尚未实现，因此本切片不虚构轮换事件。

第十三个切片接入私有 Job 创建与单 Job 私有 Artifact 上传批准审计。`authorized` 或 `intranet` Job
首次创建时写入 `private_job.created`；`upload_private_artifact = true` 时另写
`private_artifact_upload.approved`，目标均为控制面生成的 Job ID。审计不保存 Job input、URL、Header、
Cookie 或正文。

Job INSERT 与审计事件现在使用同一事务，审计失败会回滚首次创建。Project 内相同 idempotency key
和相同请求内容仍返回原 Job；控制面通过返回 ID 判断这是幂等重放，因此不会重复写创建或上传批准
事件。不同请求内容仍明确返回幂等冲突。

## 5. 后果

- 控制面和本地 Worker 可以独立部署与扩缩，但必须维护版本化任务协议。
- 所有新业务 Repository 在评审时都必须证明查询包含 `project_id` 条件。
- 相同 Project 内的 Artifact 可以按内容 Hash 去重；不同 Project 不进行物理去重。
- 私有 Worker 离线时任务保持等待或失败，不能自动改派公共云。
