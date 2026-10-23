import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WebhookVerificationError,
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
} from "../src/sdk/webhooks.js";

const body = JSON.stringify({
  id: "event-1",
  type: "job.completed",
  occurred_at: "2026-10-22T00:00:00.000Z",
  data: { job_id: "job-1", project_id: "project-1", status: "completed", result_completeness: "complete", error_code: null },
});
const nowMs = 1_790_000_000_000;
const timestamp = Math.floor(nowMs / 1_000);

function headers(signature: string, at = timestamp) {
  return { "Webhook-Id": "delivery-1", "Webhook-Timestamp": String(at), "Webhook-Signature": signature };
}

describe("webhook signatures", () => {
  it("matches the Standard Webhooks reference construction", () => {
    const secret = generateWebhookSecret();
    const expected = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
      .update(`delivery-1.${timestamp}.${body}`)
      .digest("base64");
    expect(signWebhook([secret], "delivery-1", timestamp, body)).toBe(`v1,${expected}`);
  });

  it("verifies a signed delivery and returns the event", () => {
    const secret = generateWebhookSecret();
    const event = verifyWebhook({
      secrets: secret,
      headers: headers(signWebhook([secret], "delivery-1", timestamp, body)),
      body,
      now: () => nowMs,
    });
    expect(event).toMatchObject({ id: "event-1", type: "job.completed", data: { job_id: "job-1" } });
  });

  it("accepts either secret during a rotation window", () => {
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const signature = signWebhook([current, previous], "delivery-1", timestamp, body);
    expect(() => verifyWebhook({ secrets: previous, headers: headers(signature), body, now: () => nowMs })).not.toThrow();
    expect(() => verifyWebhook({ secrets: current, headers: headers(signature), body, now: () => nowMs })).not.toThrow();
  });

  it.each([
    ["a tampered body", (secret: string) => ({ headers: headers(signWebhook([secret], "delivery-1", timestamp, body)), body: body.replace("completed", "failed") })],
    ["another secret", () => ({ headers: headers(signWebhook([generateWebhookSecret()], "delivery-1", timestamp, body)), body })],
    ["a stale timestamp", (secret: string) => ({ headers: headers(signWebhook([secret], "delivery-1", timestamp - 301, body), timestamp - 301), body })],
    ["a missing signature", () => ({ headers: { "webhook-id": "delivery-1", "webhook-timestamp": String(timestamp) }, body })],
  ])("rejects %s", (_name, build) => {
    const secret = generateWebhookSecret();
    const { headers: sent, body: received } = build(secret);
    expect(() => verifyWebhook({ secrets: secret, headers: sent, body: received, now: () => nowMs }))
      .toThrow(WebhookVerificationError);
  });

  it("rejects malformed secrets", () => {
    expect(() => signWebhook(["not-a-secret"], "delivery-1", timestamp, body)).toThrow("whsec_");
  });
});
