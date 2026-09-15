# Codex 实现对照问题清单

日期：2026-09-02
范围：对照 `docs/spec.md`、专项规范和当前代码，只记录实现错误，不评价架构选型。
原始基线：`fix/crawl-recovery-ssrf-boundaries`（`7f0b3f0`）+ 当时未提交的控制面与 Wave 0 工作树。
当前复核基线：Wave 1 内容 checkpoint `2b74175df3be3ed08555d497b2a06d1a066147c6`。
方法：原始问题来自静态合同对照；2026-09-03 的状态复核以当前源码、真实 PostgreSQL Gate 和全量 fresh Gate 为准。

状态标签：

| 标签 | 含义 |
|---|---|
| `Confirmed` | 源码路径闭合，行为与合同冲突 |
| `Likely` | 路径闭合，利用条件或威胁模型有限定 |
| `Resolved` | 原问题已由当前工作树修复并有聚焦回归证据 |
| `Not a bug` | 核对过、不列入修复 |

修复状态和验证证据以方案 C 派发计划的状态账本为准。

---

## 1. 结论

本地 Retrieval Runtime 不是空壳。SSRF 主机名拦截、授权页不进索引、MCP 二十个工具、Job 幂等 SQL、Fake-IP 字面量拦截、用户 `cancel_crawl`、SIGKILL 恢复路径，都和合同对得上。

原始问题集中在三处把不该共用的身份或校验焊在一起：

1. 把 Frontier 页 UUID 当成 Attempt Ledger 的 `requestId`，优雅停机后把「中断」重放成「这页已经失败」。
2. 直连 HTTP 在 connect 时钉住公网 IP，代理和浏览器只在发请求前做一次 DNS，连接时再解析。
3. Wave 0 前的控制面把 `assigned` 和 `running` 拆开，claim 之后不能直接 complete；challenge 先消耗再验签。

SIGKILL 那条 E2E 是绿的，所以「重启可恢复」容易被当成已经证明。它只覆盖进程被杀、来不及写 Ledger 的路径，不覆盖正常停 MCP。

2026-09-03 Wave 1 集成复核：L1、L2、L3、L5 与 C1–C4 已解决；L4 仍开放。C1–C4 已有真实 PostgreSQL 生命周期、并发、锁和回滚证据。下文保留已解决问题的原始分析，作为修复依据和历史记录。

---

## 2. 问题总表

| ID | 严重度 | 状态 | 区域 | 一句话 |
|---|---|---|---|---|
| L1 | Critical | Resolved | 本地 crawl | Attempt identity 已包含 lease generation；优雅关闭恢复已有回归测试 |
| L2 | High | Resolved | HTTP 代理 SSRF | 管理员代理流量已经由 `PolicyEgressProxy` 钉扎已批准地址 |
| L3 | High | Resolved | 浏览器 SSRF | Browser 已统一经由 policy proxy，授权重定向边界已有回归测试 |
| L4 | Medium | Confirmed | robots | `robots.txt` 任意 200 body 都当规则，软 404 HTML 等于全放行 |
| L5 | Medium | Resolved | RSL 审计 | 成功审计已移动到 cache/index/terminal commit 之前 |
| C1 | High | Resolved | 控制面 Job | claim 在同一事务进入 running，可不经 heartbeat 直接提交 |
| C2 | High | Resolved | 控制面 Job | 独立 sweeper 已接入 runtime，过期 lease 不再依赖下一次 claim |
| C3 | Medium | Resolved | Worker 会话 | challenge 验签、消费和 Session 创建已原子化 |
| C4 | Medium | Resolved | OIDC | 并发 refresh 返回 conflict，真实 reuse 只撤销对应 family |

控制面现已有 migration runner、schema version/checksum gate、正式启动前迁移，以及 PostgreSQL 16 migration/concurrency harness。Project Job/Worker Router 已接线；API Key HTTP operation 仍明确标为 Planned，OIDC、Organization、API Key 管理和 Worker bootstrap 的总 Router 接线仍未完成。

---

## 3. 本地运行时

### L1 · Critical · Resolved · 优雅停机会把进行中的 crawl 页写成永久失败

当前状态：Frontier 使用 `pageId:generation` 区分每次领取，`tests/crawl-graceful-recovery.test.ts` 覆盖优雅关闭后同库恢复。以下保留原始问题分析。

**合同**

- 中断后只回收未提交页，已提交页不重抓。
- Attempt Ledger 只重放已经提交的终态。
- `CRAWL_CANCELLED` 是用户取消，不是进程退出。

**实际**

Frontier 把稳定的页 UUID 传给 Reader 当 `requestId`：

```506:516:src/runtime/frontier.ts
      const artifact = await this.reader.crawlPageArtifact({
        url: lease.page.normalizedUrl,
        requestId: lease.page.id,
        // ...
        signal,
      });
```

Executor 把任意 `input.signal` abort 都标成取消：

```477:484:src/runtime/executor.ts
  private normalizeCancellation(...) {
    if (input.signal?.aborted === true) {
      return new ReadError("CRAWL_CANCELLED", "The crawl job was cancelled.");
    }
```

该错误随后被补上 `execution.requestId`。Reader 在重新抛出前写入失败终态：

```120:136:src/reader.ts
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.execution !== null) {
        this.attemptLedger?.commitTerminal({
          requestId: normalized.execution.requestId,
          state: failureTerminalState(normalized),
          error: { code: normalized.code, /* ... */ },
        });
      }
```

`DurableCrawlService.close()` 先 abort 进行中的页，再等 promise。`executeLease` 看到 `this.closing` 后调用 `releaseLease`，把同一 `page.id` 放回 `queued`：

```537:540:src/runtime/frontier.ts
      if (this.closing) {
        this.store.releaseLease(lease);
        return;
      }
```

```734:738:src/frontier-store.ts
      this.database.prepare(`
        UPDATE crawl_frontier SET state = 'queued', lease_owner = NULL,
          lease_expires_at_ms = NULL, started_at_ms = NULL, reserved_usage_json = ? WHERE id = ?
```

下次进程用新的 worker owner 领取同一页。Reader 先查 Ledger：

```179:185:src/reader.ts
    const terminal = this.attemptLedger?.getTerminal(requestId, plan.id) ?? null;
    if (terminal !== null) {
      if (terminal.error !== null) {
        throw new ReadError(terminal.error.code, terminal.error.message, {
```

不再发请求，直接重放 `CRAWL_CANCELLED`。此时 `closing` 为 false、用户也没 cancel，`executeLease` 走 `commitFailure`，该页永久失败。

**复现条件**

1. MCP/服务进程里有进行中的异步 crawl 页（已经进入 HTTP/Browser stage，错误带 `execution`）。
2. 正常退出：`close()`、停 MCP、Ctrl+C 走到 shutdown，而不是 SIGKILL。
3. 再次启动同一数据目录。

**不影响**

- 空闲时重启。
- SIGKILL：进程来不及写 Ledger。现有 `tests/e2e/crawl-recovery.e2e.test.ts` 只覆盖这条。
- 用户 `cancel_crawl`：`isCancelRequested` 为真，Frontier 发 `commitStopped`，页不会再入队。
- `pause`：不 abort 进行中的页。

**建议修复**

任选其一，不要两套语义并存：

1. 关闭/释放 lease 时不要对将被重新入队的 `requestId` 写失败终态；或在 `releaseLease` 时删除/作废对应 terminal。
2. 不要用可重入队的 Frontier 页 UUID 当 Ledger `requestId`。每次领取用 `pageId + generation` 或新 UUID。
3. 区分 `CRAWL_CANCELLED`（用户取消）和中断/丢 lease。后者不得成为可重放终态。

**验证**

新增测试：start crawl → 等至少一页 leased → `jobs.close()` → 新 `DurableCrawlService` 同库启动 → 该页必须重新抓取，而不是重放 `CRAWL_CANCELLED`。现有 SIGKILL E2E 应继续绿。

---

### L2 · High · Resolved · 代理路径没有直连那套 DNS 钉扎

当前状态：管理员代理流量经 `PolicyEgressProxy` 转发并钉扎 policy 已批准的地址，`tests/policy-egress-proxy.test.ts` 覆盖重新解析边界。以下保留原始问题分析。

**合同**

`docs/spec.md` 安全边界、`docs/proxy-pool-spec.md`：代理只改出站传输，不允许访问 URL policy 会拒绝的目标；初始 URL 和重定向逐跳校验。

**实际**

直连把 `safeLookup` 接到 connect，TCP 只能落到已经判过公网的地址：

```155:159:src/fetch/http.ts
    this.directDispatcher = new Agent({
      connect: { lookup: safeLookup(urlPolicy) },
```

有 `DIAOYAN_PROXY_URLS` 时改用裸 `ProxyAgent`：

```328:337:src/fetch/http.ts
    if (proxyUri === null) {
      return this.directDispatcher;
    }
    const dispatcher = new ProxyAgent(proxyUri);
```

顺序是：`assertPublic`（`UrlPolicy.resolve`，缓存 60 秒）→ 代理自己再解析并连接。两次 DNS 可以给出不同地址。这是 DNS rebinding：先回公网让 policy 通过，再回环回/链路本地/云 metadata。

**影响**

Agent 会抓调用方给的任意 URL。配置了管理员代理后，恶意站点可以打到本机或内网，而直连路径本来挡得住。`tests/proxy.test.ts` 不覆盖 SSRF/rebinding。

**建议修复**

给 `ProxyAgent` 同样的 `connect.lookup: safeLookup(urlPolicy)`，或在确认代理会连到的地址后再发请求。回归：直连 SSRF 用例在开启代理后仍须拦截；增加「第一次公网、第二次私网」的解析器测试。

---

### L3 · High · Resolved · 浏览器子请求同样没有钉住解析结果

当前状态：Browser 使用同一 policy proxy；`tests/browser-authorization.test.ts` 覆盖主导航越界重定向和第三方子资源边界。以下保留原始问题分析。

**合同**

浏览器子请求同样执行目标校验。

**实际**

路由拦截里调用 `assertPublic`，然后 `route.continue()` / `route.fetch()`，由 Chromium 再解析：

```313:316:src/fetch/browser.ts
          const parsed = this.urlPolicy.parse(requestUrl);
          await this.urlPolicy.assertPublic(parsed);
```

威胁模型和 L2 相同，钉扎比 HTTP 更难（Playwright 不暴露和 undici 一样的 custom lookup）。标 `Likely`：路径确认，利用取决于 Chrome 是否在拦截后再解析。

**建议修复**

对主导航和子请求，在 continue 前把目标钉到 `assertPublic` 返回的地址，或对解析到非公网的请求 `route.abort`。至少给主导航做与 HTTP 同级的测试。

---

### L4 · Medium · `robots.txt` HTTP 200 不检查是否真是规则文本

**合同**

规则明确禁止，或无法安全取得规则时，失败关闭（`ROBOTS_UNAVAILABLE`）。

**实际**

404/410 当成「没有 robots、允许抓」（常见约定）。其它非 200 会失败。200 则不管 Content-Type，整段 body 交给 `robots-parser`：

```138:149:src/security/robots.ts
    if (response.status !== 200) {
      throw new ReadError("ROBOTS_UNAVAILABLE", ...);
    }
    const loaded = {
      text: response.body,
    };
```

HTML 软 404、JSON 错误页、WAF 挑战页被当成规则。parser 通常解析不出 `Disallow`，效果等于全放行。这不是「站点没有 robots.txt」，是「没安全拿到规则却当允许」。

**建议修复**

200 且 Content-Type 不是 `text/plain`（及明确兼容类型）时返回 `ROBOTS_UNAVAILABLE`。对明显 HTML/JSON body 失败关闭。补一条软 404 HTML 的测试。

---

### L5 · Medium · Resolved · RSL 审计失败时，成功结果已经落盘

当前状态：Reader 在 cache、index 和 terminal commit 前记录成功审计；`tests/reader-audit-order.test.ts` 覆盖审计失败时不留下成功痕迹。以下保留原始问题分析。

**合同**

审计写入失败必须使本次读取失败，不得静默丢审计。

**实际**

代码会在审计失败时抛 `INTERNAL_ERROR`，但成功路径顺序是：

1. `cache.put`（共享缓存）
2. `localIndex.put`（FTS）
3. `attemptLedger.commitTerminal`（成功终态）
4. 外层 `rslAudit.recordSuccess` / `metrics.recordSuccess`

```281:298:src/reader.ts
      artifactKey = this.cache.put(key, result, ...);
      if (artifactKey !== null) {
        this.localIndex?.put(result, { artifactKey, rawRef: publication.rawRef });
      }
    if (operation !== "map" && artifactKey !== null) {
      this.attemptLedger?.commitTerminal({ /* success */ });
```

```146:148:src/reader.ts
    this.rslAudit?.recordSuccess(result);
    this.metrics?.recordSuccess(result, Date.now() - startedAt);
```

调用方看到失败；磁盘上已经是成功页。下次 `prefer-cache` 会返回这份从未审计成功的内容。`rsl-audit` 测试不覆盖与 Reader 的提交顺序。

**建议修复**

先审计（以及需要与读取同命运的 metrics），成功后再 cache/index/terminal；或把四者放进同一事务/补偿回滚。加测试：审计插入失败时 cache lookup 必须仍为空。

---

## 4. 控制面（Wave 1）

这些路径已提交到当前功能分支。以下代码和分析描述修复前行为，保留作历史依据。

### C1 · High · Resolved · Worker 必须先 heartbeat 才能 complete

当前状态：claim 在同一事务把 Job 置为 running；真实 PostgreSQL 生命周期覆盖无 heartbeat 的 publication/complete。以下保留修复前分析。

`claimNext` 把 Job 写成 `assigned`：

```562:565:src/control-plane/project-scope.ts
      const assigned = await transaction.query<ControlPlaneJobRow>(`
        UPDATE jobs SET status = 'assigned', updated_at = $3
        WHERE id = $1 AND project_id = $2 AND status = 'queued'
```

`complete` 以及 `organization-authorization.ts` 里的事件/publication 提交都要求 `jobs.status = 'running'`：

```643:646:src/control-plane/project-scope.ts
        UPDATE jobs SET status = $3, result_completeness = $4, error_code = $5,
          completed_at = $6, updated_at = $6
        WHERE id = $1 AND project_id = $2 AND status = 'running'
```

只有 `heartbeat` 会把 `assigned → running`。lease 仍有效时，领完立刻提交会得到 `LeaseFencedError`。`tests/control-plane-project-scope.test.ts` 还把「complete SQL 含 `status = 'running'`」写成断言，脚本数据库测不到 claim→complete。

**建议修复**

claim 时写成 `running`，或 complete/结果提交允许 `status IN ('assigned', 'running')`。用真 PostgreSQL 测：claim → complete，中间不 heartbeat。

---

### C2 · High · Resolved · 过期 lease 只在下一次 claim 时回收

当前状态：独立非重叠 sweeper 已接入 runtime；启动首轮失败不监听，周期失败进入 fatal shutdown，真实 PostgreSQL 覆盖恢复、重领和竞态。以下保留修复前分析。

`recoverExpiredJobLeases` 只从 `claimNext` 调用。heartbeat、complete、pause、独立 sweeper 都不会跑它。该 Project 若没有下一次 claim，Job 会停在 `assigned`/`running`，lease 行已过期。ADR 要求过期 lease 自行按原 placement 重新入队。

**建议修复**

heartbeat/complete 前回收；或短周期 sweeper。pause/cancel 已在同事务取消 active lease，那条是对的。

---

### C3 · Medium · Resolved · 一次性 challenge 在验签前就被消耗

当前状态：challenge 行在事务内锁定，验签后原子消费并创建 Session；坏签名、写失败和并发只成功一次均有真实 PostgreSQL 证据。以下保留修复前分析。

```596:620:src/control-plane/api-key-service.ts
    const consumed = await this.database.query<...>(`
      UPDATE worker_session_challenges AS challenges SET consumed_at = $3
      ...
    `);
    // ...
      if (!verifySignature(...)) throw new WorkerAuthenticationError();
```

没有包在同一事务里。坏签名、或验签成功后 INSERT session 失败，challenge 也已经 `consumed_at`。现有测试把「坏签名仍 consumed」当成预期。

**建议修复**

验签成功后再消耗；整段放进事务，失败回滚。被盗用的 challenge 仍应只能成功一次。

---

### C4 · Medium · Resolved · 并发 refresh 被当成盗用

当前状态：5 秒窄窗口内的重叠请求返回 rotation conflict，不签发也不撤销；窗口外 reuse 只撤销对应 family。真实 PostgreSQL 覆盖并发、reuse 和回滚。以下保留修复前分析。

`rotateRefreshToken` 在 `used_at !== null` 时撤销该用户全部 refresh family：

```382:389:src/control-plane/oidc-session-service.ts
      if (current.used_at !== null) {
        await transaction.query<IdRow>(`
          UPDATE refresh_tokens
          SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
          WHERE user_id = $1
```

`FOR UPDATE` 会串行化。两个标签页同时用同一颗未使用 token：第一个旋转成功，第二个看到 `used_at` 已写，走 reuse 分支，用户所有会话被踢。单请求重用检测符合 ADR；并发旋转是实现缺陷。

**建议修复**

若 `used_at` 已写且 `previous_token_id` 指向刚发出的 tip，返回已有 tip（narrow grace）；或把 reuse 检测限制在 family 内并允许极短重叠。不要把正常并发旋转做成全局登出。

---

## 5. 核对过、不列为问题

| 项 | 结果 |
|---|---|
| 授权 Profile 进 FTS | `LocalPageIndex.put` 跳过 `authProfile !== null`；受限 RSL 使 `cache.put` 返回 null，index 不会写 |
| MCP 工具数 | 20 个，与 spec 一致 |
| 控制面租户条件 | 业务查询带 `project_id`，无脱离租户的 `findById` |
| Job 幂等 | `ON CONFLICT (project_id, idempotency_key) DO UPDATE WHERE request_hash = EXCLUDED.request_hash` 正确 |
| Fake-IP | 字面量 `198.18.0.0/15` 仍 SSRF；仅解析结果在开关打开时允许 |
| 用户取消 crawl | `commitStopped`，页不重新入队 |
| SIGKILL 恢复 | 来不及写 Ledger，页可重新领取；E2E 覆盖此路径 |
| HTTP→Browser 升级 | `after-invalid` 仅对 `SHELL_ONLY` / `INCOMPLETE_CONTENT`，与 spec 一致 |
| 控制面 HTTP / `pg` | 已有 migration runner、PostgreSQL 16 Gate、listener 和 Project Job/Worker Router；API Key/OIDC/Organization/Worker bootstrap 总 Router 接线仍未完成 |

Frontier 本地 lease 在 complete 时不检查 `lease_expires_at_ms`。测试把过期后仍可 heartbeat/commit 写成允许，单数据目录单 worker 下可解释为抖动容忍。不单独开编号；若以后多 worker 共库，应再审。

---

## 6. 建议处理

L1、L2、L3、L5 与 C1–C4 已完成；当前唯一仍开放的编号问题是 L4。

| 阶段 | 项 | 依赖 | 完成标准 |
|---|---|---|---|
| 1 | L4 | 无 | robots 非文本 200 失败关闭 |

Wave 0 已完成 L1/L2/L3/L5 的聚焦回归；Wave 1 又完成 C1–C4、真实 PostgreSQL 与合同 Gate。相关聚焦命令包括：

```text
pnpm check
pnpm test -- tests/e2e/crawl-recovery.e2e.test.ts tests/frontier-store.test.ts tests/attempt-ledger.test.ts
```

`pnpm test:postgres` 已覆盖 migration、Job 全生命周期与锁序、应用时钟偏移下的数据库时钟 fencing，以及 Auth 并发和回滚；Wave 1 checkpoint 的专用 PostgreSQL Gate 为 35/35。

---

## 7. 本文不覆盖

- 架构是否该上云、要不要多租户、垂直搜索是否算搜索引擎。
- 历史 Nightly 280/280 是否仍绑定当前 HEAD（证据过期，不是代码 bug）；当前全量 Gate 为 76 个测试文件，其中 72 个文件、690 个用例通过，4 个 PostgreSQL 文件、35 个用例由专用 `test:postgres` Gate 另行真实执行并通过。
- 未跑的 flaky、性能、30 万页容量。
- 完整的控制面 OpenAPI/Router 字段级 parity；Project Job 和 Worker HTTP 已接线，API Key HTTP 模块尚未进入总 Router，其余控制面 HTTP 仍未完成。
