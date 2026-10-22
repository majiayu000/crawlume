# TypeScript SDK

`crawlume/sdk`（源码 `src/sdk/client.ts`）是 Project Control API 的客户端，实现
[`hybrid-platform-architecture-plan.md`](./hybrid-platform-architecture-plan.md) §16.2 的第一版范围。

```ts
import { CrawlumeClient } from "crawlume/sdk";

const client = new CrawlumeClient({
  baseUrl: "https://control.example/v1",
  apiKey: process.env.CRAWLUME_API_KEY!,
  projectId: "…",
});

const job = await client.createJob({
  type: "read",
  input: { url: "https://example.com/" },
  data_class: "public",
  placement: { class: "public", pinned_worker_id: null },
  required_capabilities: { http: true },
  budget: {
    deadline_ms: 300_000,
    max_provider_attempts: 2,
    max_document_bytes: 1_000_000,
    max_browser_ms: 0,
    max_browser_contexts: 0,
  },
  policy_version: "2026-09-02",
  upload_private_artifact: false,
});
const finished = await client.waitForJob(job.id, { timeoutMs: 120_000 });
for await (const publication of client.publications(job.id)) {
  console.log(publication.sequence, publication.artifact.content_hash);
}
```

## 行为

- API Key 需要 `tasks:write`（创建、暂停、恢复、取消）和 `results:read`（读取 Job 与 publication）。
- `createJob` 未传 `idempotencyKey` 时生成 UUID；同一次调用的重试复用同一个 key。
- 失败抛出 `ControlPlaneError`，带 `status`、`code`、`retryable`、`requestId` 和原始 RFC 7807 `problem`。
- 只有服务端标记 `retryable: true` 的失败才重试，默认最多 3 次，指数退避并尊重 `Retry-After`，单次等待不超过
  30 秒；SDK 发出的请求都是幂等的。
- `publications()` 按服务端 cursor 依次返回全部 publication；`waitForJob()` 轮询到终态，超时抛错。

## Webhook 验签

投递使用 [Standard Webhooks](https://www.standardwebhooks.com/) 签名：`webhook-id`、`webhook-timestamp`、
`webhook-signature` 三个头，HMAC-SHA256 覆盖 `{id}.{timestamp}.{body}`。轮换 secret 后 24 小时内会同时带新旧
两个签名。

```ts
import { verifyWebhook } from "crawlume/sdk/webhooks";

const event = verifyWebhook({
  secrets: [process.env.WEBHOOK_SECRET!],
  headers: request.headers,
  body: rawBody, // 未经 JSON 重新序列化的原始请求体
});
if (event.type === "job.completed") console.log(event.data.job_id);
```

时间戳超出 5 分钟或签名不匹配时抛出 `WebhookVerificationError`。同一 `webhook-id` 可能因重试重复到达，
接收方应按它去重。
