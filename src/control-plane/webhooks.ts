import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ReadError } from "../errors.js";
import { parseRetryAfterMs } from "../sdk/client.js";
import { generateWebhookSecret, signWebhook } from "../sdk/webhooks.js";
import type { UrlPolicy } from "../security/url-policy.js";
import type { ControlPlaneDatabase, ProjectScope } from "./project-scope.js";

export const webhookEventTypes = ["job.completed", "job.failed", "job.cancelled"] as const;
export type WebhookEventType = (typeof webhookEventTypes)[number];

export type WebhookEndpoint = Readonly<{
  id: string;
  url: string;
  eventTypes: readonly WebhookEventType[];
  status: "active" | "disabled";
  createdAt: Date;
}>;

export type WebhookDelivery = Readonly<{
  id: string;
  eventId: string;
  endpointId: string;
  eventType: WebhookEventType;
  status: "pending" | "succeeded" | "dead_letter";
  attemptCount: number;
  nextAttemptAt: Date;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
}>;

type ProjectRef = Pick<ProjectScope, "projectId">;

export class WebhooksDisabledError extends Error {
  readonly code = "WEBHOOKS_DISABLED";
  constructor() {
    super("Webhooks are disabled because no webhook encryption key is configured.");
    this.name = "WebhooksDisabledError";
  }
}

export class WebhookEndpointInvalidError extends Error {
  readonly code = "WEBHOOK_ENDPOINT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "WebhookEndpointInvalidError";
  }
}

export class WebhookNotFoundError extends Error {
  readonly code = "WEBHOOK_NOT_FOUND";
  constructor(kind: "endpoint" | "event") {
    super(`The webhook ${kind} was not found in this Project.`);
    this.name = "WebhookNotFoundError";
  }
}

/** AES-256-GCM envelope for endpoint secrets: nonce(12) | tag(16) | ciphertext. */
export class WebhookSecretCipher {
  private constructor(private readonly key: Buffer) {}

  static fromKey(key: Buffer): WebhookSecretCipher {
    if (key.length !== 32) throw new Error("The webhook encryption key must be 32 bytes.");
    return new WebhookSecretCipher(key);
  }

  static async fromFile(path: string): Promise<WebhookSecretCipher> {
    const raw = await readFile(path);
    const text = raw.toString("utf8").trim();
    const key = raw.length === 32 ? raw : Buffer.from(text, /^[0-9a-f]{64}$/iu.test(text) ? "hex" : "base64");
    return WebhookSecretCipher.fromKey(key);
  }

  encrypt(secret: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(envelope: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, envelope.subarray(0, 12));
    decipher.setAuthTag(envelope.subarray(12, 28));
    return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString("utf8");
  }
}

type EndpointRow = {
  id: string;
  url: string;
  event_types: WebhookEventType[];
  status: "active" | "disabled";
  created_at: Date;
};

type DeliveryRow = {
  id: string;
  event_id: string;
  endpoint_id: string;
  event_type: WebhookEventType;
  status: WebhookDelivery["status"];
  attempt_count: number;
  next_attempt_at: Date;
  last_status_code: number | null;
  last_error: string | null;
  created_at: Date;
};

function endpointFromRow(row: EndpointRow): WebhookEndpoint {
  return Object.freeze({
    id: row.id, url: row.url, eventTypes: Object.freeze([...row.event_types]),
    status: row.status, createdAt: row.created_at,
  });
}

function deliveryFromRow(row: DeliveryRow): WebhookDelivery {
  return Object.freeze({
    id: row.id, eventId: row.event_id, endpointId: row.endpoint_id, eventType: row.event_type,
    status: row.status, attemptCount: row.attempt_count, nextAttemptAt: row.next_attempt_at,
    lastStatusCode: row.last_status_code, lastError: row.last_error, createdAt: row.created_at,
  });
}

const secretRotationWindowMs = 24 * 60 * 60 * 1_000;

export class WebhookService {
  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly cipher: WebhookSecretCipher | null,
    private readonly urlPolicy: Pick<UrlPolicy, "parse" | "assertPublic">,
  ) {}

  async createEndpoint(
    scope: ProjectRef,
    input: Readonly<{ url: string; eventTypes: readonly WebhookEventType[] }>,
  ): Promise<Readonly<{ endpoint: WebhookEndpoint; secret: string }>> {
    const cipher = this.requireCipher();
    const url = await this.validateUrl(input.url);
    const eventTypes = [...new Set(input.eventTypes)];
    if (eventTypes.length === 0 || eventTypes.some((type) => !webhookEventTypes.includes(type))) {
      throw new WebhookEndpointInvalidError("event_types must list supported webhook event types.");
    }
    const secret = generateWebhookSecret();
    const result = await this.database.query<EndpointRow>(`
      INSERT INTO webhook_endpoints(id, project_id, url, event_types, secret_ciphertext, status)
      VALUES ($1, $2, $3, $4::text[], $5, 'active')
      RETURNING id, url, event_types, status, created_at
    `, [randomUUID(), scope.projectId, url, eventTypes, cipher.encrypt(secret)]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("Webhook endpoint insert returned no row.");
    return Object.freeze({ endpoint: endpointFromRow(row), secret });
  }

  async listEndpoints(scope: ProjectRef): Promise<readonly WebhookEndpoint[]> {
    const result = await this.database.query<EndpointRow>(`
      SELECT id, url, event_types, status, created_at FROM webhook_endpoints
      WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100
    `, [scope.projectId]);
    return result.rows.map(endpointFromRow);
  }

  async disableEndpoint(scope: ProjectRef, endpointId: string): Promise<void> {
    const result = await this.database.query<{ id: string }>(`
      UPDATE webhook_endpoints SET status = 'disabled', updated_at = clock_timestamp()
      WHERE id = $1 AND project_id = $2 RETURNING id
    `, [endpointId, scope.projectId]);
    if (result.rows.length === 0) throw new WebhookNotFoundError("endpoint");
  }

  /** Issues a new secret; the previous one stays valid for signing for 24 hours. */
  async rotateSecret(scope: ProjectRef, endpointId: string): Promise<string> {
    const cipher = this.requireCipher();
    const secret = generateWebhookSecret();
    const result = await this.database.query<{ id: string }>(`
      UPDATE webhook_endpoints SET
        previous_secret_ciphertext = secret_ciphertext,
        previous_secret_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
        secret_ciphertext = $4,
        updated_at = clock_timestamp()
      WHERE id = $1 AND project_id = $2 AND status = 'active'
      RETURNING id
    `, [endpointId, scope.projectId, secretRotationWindowMs, cipher.encrypt(secret)]);
    if (result.rows.length === 0) throw new WebhookNotFoundError("endpoint");
    return secret;
  }

  /** Queues a fresh delivery of an existing event to every active subscribed endpoint. */
  async redeliver(scope: ProjectRef, eventId: string): Promise<number> {
    this.requireCipher();
    return this.database.transaction(async (transaction) => {
      const event = await transaction.query<{ event_type: string }>(
        "SELECT event_type FROM webhook_events WHERE id = $1 AND project_id = $2",
        [eventId, scope.projectId],
      );
      const eventType = event.rows[0]?.event_type;
      if (eventType === undefined) throw new WebhookNotFoundError("event");
      const queued = await transaction.query<{ id: string }>(`
        INSERT INTO webhook_deliveries(id, project_id, event_id, endpoint_id, status, next_attempt_at)
        SELECT gen_random_uuid(), $1, $2, id, 'pending', clock_timestamp()
        FROM webhook_endpoints
        WHERE project_id = $1 AND status = 'active' AND $3 = ANY(event_types)
        RETURNING id
      `, [scope.projectId, eventId, eventType]);
      return queued.rows.length;
    });
  }

  async listDeliveries(scope: ProjectRef, limit: number): Promise<readonly WebhookDelivery[]> {
    const result = await this.database.query<DeliveryRow>(`
      SELECT deliveries.id, deliveries.event_id, deliveries.endpoint_id, events.event_type,
        deliveries.status, deliveries.attempt_count, deliveries.next_attempt_at,
        deliveries.last_status_code, deliveries.last_error, deliveries.created_at
      FROM webhook_deliveries AS deliveries
      INNER JOIN webhook_events AS events
        ON events.id = deliveries.event_id AND events.project_id = deliveries.project_id
      WHERE deliveries.project_id = $1
      ORDER BY deliveries.created_at DESC, deliveries.id DESC
      LIMIT $2
    `, [scope.projectId, limit]);
    return result.rows.map(deliveryFromRow);
  }

  private requireCipher(): WebhookSecretCipher {
    if (this.cipher === null) throw new WebhooksDisabledError();
    return this.cipher;
  }

  private async validateUrl(input: string): Promise<string> {
    let url: URL;
    try {
      url = this.urlPolicy.parse(input);
      if (url.protocol !== "https:") throw new WebhookEndpointInvalidError("Webhook URLs must use https.");
      if (url.href.length > 2_048) throw new WebhookEndpointInvalidError("Webhook URL is too long.");
      await this.urlPolicy.assertPublic(url);
    } catch (error) {
      if (error instanceof WebhookEndpointInvalidError) throw error;
      if (error instanceof ReadError) throw new WebhookEndpointInvalidError(error.message);
      throw error;
    }
    return url.href;
  }
}

type DueDeliveryRow = {
  id: string;
  project_id: string;
  attempt_count: number;
  url: string;
  endpoint_status: "active" | "disabled";
  secret_ciphertext: Buffer;
  previous_secret_ciphertext: Buffer | null;
  previous_secret_expires_at: Date | null;
  event_id: string;
  event_type: WebhookEventType;
  payload: Record<string, unknown>;
  occurred_at: Date;
};

export type WebhookDispatcherOptions = Readonly<{
  fetch?: typeof fetch;
  now?: () => Date;
  batchSize?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  retryBaseMs?: number;
}>;

const maxRetryDelayMs = 60 * 60 * 1_000;

function truncate(value: string): string {
  return value.length <= 1_024 ? value : value.slice(0, 1_024);
}

/**
 * Claims due deliveries, POSTs signed payloads and records every attempt. Endpoint failures are
 * recorded as attempts; only database failures escape sweep() and stop the runner.
 */
export class WebhookDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly cipher: WebhookSecretCipher,
    private readonly urlPolicy: Pick<UrlPolicy, "parse" | "assertPublic">,
    options: WebhookDispatcherOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 20;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retryBaseMs = options.retryBaseMs ?? 30_000;
  }

  async sweep(): Promise<number> {
    const due = await this.claim();
    await Promise.all(due.map((delivery) => this.deliver(delivery)));
    return due.length;
  }

  private async claim(): Promise<DueDeliveryRow[]> {
    const result = await this.database.query<DueDeliveryRow>(`
      WITH claimed AS (
        UPDATE webhook_deliveries SET locked_until = clock_timestamp() + ($2::bigint * interval '1 millisecond')
        WHERE id IN (
          SELECT id FROM webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= clock_timestamp()
            AND (locked_until IS NULL OR locked_until <= clock_timestamp())
          ORDER BY next_attempt_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        RETURNING id, project_id, event_id, endpoint_id, attempt_count
      )
      SELECT claimed.id, claimed.project_id, claimed.attempt_count,
        endpoints.url, endpoints.status AS endpoint_status, endpoints.secret_ciphertext,
        endpoints.previous_secret_ciphertext, endpoints.previous_secret_expires_at,
        events.id AS event_id, events.event_type, events.payload, events.occurred_at
      FROM claimed
      INNER JOIN webhook_endpoints AS endpoints
        ON endpoints.id = claimed.endpoint_id AND endpoints.project_id = claimed.project_id
      INNER JOIN webhook_events AS events
        ON events.id = claimed.event_id AND events.project_id = claimed.project_id
    `, [this.batchSize, this.timeoutMs * 3]);
    return result.rows;
  }

  private async deliver(delivery: DueDeliveryRow): Promise<void> {
    const startedAt = this.now();
    const attempt = delivery.attempt_count + 1;
    if (delivery.endpoint_status !== "active") {
      await this.finish(delivery, attempt, startedAt, "dead_letter", null, "The endpoint is disabled.", null);
      return;
    }
    const body = JSON.stringify({
      id: delivery.event_id,
      type: delivery.event_type,
      occurred_at: delivery.occurred_at.toISOString(),
      data: delivery.payload,
    });
    const secrets = [this.cipher.decrypt(delivery.secret_ciphertext)];
    if (delivery.previous_secret_ciphertext !== null && delivery.previous_secret_expires_at !== null &&
        delivery.previous_secret_expires_at > startedAt) {
      secrets.push(this.cipher.decrypt(delivery.previous_secret_ciphertext));
    }
    const timestamp = Math.floor(startedAt.getTime() / 1_000);
    let statusCode: number | null = null;
    let error: string | null = null;
    let retryAfter: string | null = null;
    try {
      const url = this.urlPolicy.parse(delivery.url);
      await this.urlPolicy.assertPublic(url);
      const response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "content-type": "application/json",
          "user-agent": "Diaoyan-Webhooks/1",
          "webhook-id": delivery.id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signWebhook(secrets, delivery.id, timestamp, body),
        },
        body,
      });
      statusCode = response.status;
      retryAfter = response.headers.get("retry-after");
      await response.body?.cancel();
      if (statusCode < 200 || statusCode > 299) error = `Endpoint returned HTTP ${statusCode}.`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (error === null) {
      await this.finish(delivery, attempt, startedAt, "succeeded", statusCode, null, null);
      return;
    }
    if (attempt >= this.maxAttempts) {
      await this.finish(delivery, attempt, startedAt, "dead_letter", statusCode, error, null);
      return;
    }
    const backoff = Math.min(maxRetryDelayMs, this.retryBaseMs * 2 ** (attempt - 1));
    const delayMs = Math.min(maxRetryDelayMs, parseRetryAfterMs(retryAfter, startedAt.getTime()) ?? backoff);
    await this.finish(
      delivery, attempt, startedAt, "pending", statusCode, error, new Date(startedAt.getTime() + delayMs),
    );
  }

  private async finish(
    delivery: DueDeliveryRow,
    attempt: number,
    startedAt: Date,
    status: "pending" | "succeeded" | "dead_letter",
    statusCode: number | null,
    error: string | null,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime());
    await this.database.transaction(async (transaction) => {
      await transaction.query(`
        INSERT INTO webhook_delivery_attempts(delivery_id, attempt, status_code, error, started_at, duration_ms)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [delivery.id, attempt, statusCode, error === null ? null : truncate(error), startedAt, durationMs]);
      await transaction.query(`
        UPDATE webhook_deliveries SET status = $2, attempt_count = $3, last_status_code = $4,
          last_error = $5, next_attempt_at = COALESCE($6, next_attempt_at), locked_until = NULL,
          updated_at = clock_timestamp()
        WHERE id = $1
      `, [delivery.id, status, attempt, statusCode, error === null ? null : truncate(error), nextAttemptAt]);
    });
  }
}
