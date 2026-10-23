import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signatures follow the Standard Webhooks scheme (https://www.standardwebhooks.com/):
// HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{body}" with a "whsec_" base64 secret.

const secretPrefix = "whsec_";

export type WebhookEvent = Readonly<{
  id: string;
  type: "job.completed" | "job.failed" | "job.cancelled";
  occurred_at: string;
  data: Readonly<{
    job_id: string;
    project_id: string;
    status: string;
    result_completeness: "complete" | "partial" | null;
    error_code: string | null;
  }>;
}>;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export function generateWebhookSecret(): string {
  return `${secretPrefix}${randomBytes(32).toString("base64")}`;
}

function secretBytes(secret: string): Buffer {
  if (!secret.startsWith(secretPrefix)) throw new TypeError("Webhook secrets must start with whsec_.");
  const bytes = Buffer.from(secret.slice(secretPrefix.length), "base64");
  if (bytes.length < 24) throw new TypeError("Webhook secret is too short.");
  return bytes;
}

function signature(secret: string, id: string, timestamp: string, body: string): string {
  return createHmac("sha256", secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/** Returns the webhook-signature header value, one "v1,<signature>" entry per secret. */
export function signWebhook(secrets: readonly string[], id: string, timestamp: number, body: string): string {
  if (secrets.length === 0) throw new TypeError("At least one webhook secret is required.");
  return secrets.map((secret) => `v1,${signature(secret, id, String(timestamp), body)}`).join(" ");
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (found === undefined || found.length === 0) throw new WebhookVerificationError(`Missing ${name} header.`);
  return found;
}

/**
 * Verifies a delivery and returns its event. Accepts several secrets so receivers can verify during
 * a rotation window, and rejects timestamps outside toleranceSeconds to bound replays.
 */
export function verifyWebhook(options: Readonly<{
  secrets: string | readonly string[];
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
  toleranceSeconds?: number;
  now?: () => number;
}>): WebhookEvent {
  const id = header(options.headers, "webhook-id");
  const timestamp = header(options.headers, "webhook-timestamp");
  const signatures = header(options.headers, "webhook-signature").split(" ");
  if (!/^[0-9]+$/u.test(timestamp)) throw new WebhookVerificationError("Invalid webhook-timestamp header.");
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1_000);
  if (Math.abs(nowSeconds - Number(timestamp)) > (options.toleranceSeconds ?? 300)) {
    throw new WebhookVerificationError("Webhook timestamp is outside the tolerance window.");
  }
  const secrets = typeof options.secrets === "string" ? [options.secrets] : options.secrets;
  const provided = signatures
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => Buffer.from(entry.slice(3), "base64"));
  const matched = secrets.some((secret) => {
    const expected = Buffer.from(signature(secret, id, timestamp, options.body), "base64");
    return provided.some((candidate) =>
      candidate.length === expected.length && timingSafeEqual(candidate, expected));
  });
  if (!matched) throw new WebhookVerificationError("No webhook signature matched.");
  return JSON.parse(options.body) as WebhookEvent;
}
