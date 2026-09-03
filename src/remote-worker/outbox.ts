import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { RemoteWorkerClient, RemoteWorkerHttpError } from "./client.js";

const maximumPayloadBytes = 64 * 1_024;
const schemaVersion = 1;
const uuidSchema = z.uuid();
const generationSchema = z.number().int().positive().safe();
const dedupeKeySchema = z.string().trim().min(1).max(128);
const blockedCodeSchema = z.string().trim().min(1).max(128);
const contentHashSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).refine((value) => Buffer.from(value, "base64url").toString("base64url") === value);
const usageSchema = z.record(z.string(), z.number().finite().nonnegative()).refine((value) => {
  const entries = Object.entries(value);
  return entries.length <= 32 && entries.every(([key]) => key.trim().length > 0 && key.length <= 64);
});
const leaseSchema = z.object({
  jobId: uuidSchema, leaseId: uuidSchema, generation: generationSchema,
}).strict();
const eventInputSchema = z.object({
  dedupeKey: dedupeKeySchema,
  eventType: z.string().trim().min(1).max(64),
  pageStatus: z.number().int().min(100).max(599).nullable(),
  errorCode: z.string().trim().min(1).max(128).nullable(),
  provider: z.string().trim().min(1).max(128).nullable(),
  byteCount: z.number().int().nonnegative().safe(),
  durationMs: z.number().int().nonnegative().safe(),
  contentHash: contentHashSchema.nullable(), usage: usageSchema, occurredAt: z.date(),
}).strict();
const publicationInputSchema = z.object({
  dedupeKey: dedupeKeySchema,
  contentHash: contentHashSchema, byteCount: z.number().int().nonnegative().safe(),
  mediaType: z.string().trim().min(1).max(255), completeness: z.enum(["complete", "partial"]),
  storage: z.enum(["worker_local", "cloud_object"]),
}).strict();
const eventPayloadSchema = z.object({
  generation: generationSchema, local_sequence: z.number().int().positive().safe(),
  event_type: z.string().min(1).max(64), page_status: z.number().int().min(100).max(599).nullable(),
  error_code: z.string().min(1).max(128).nullable(), provider: z.string().min(1).max(128).nullable(),
  byte_count: z.number().int().nonnegative().safe(), duration_ms: z.number().int().nonnegative().safe(),
  content_hash: contentHashSchema.nullable(), usage: usageSchema,
  occurred_at: z.string().datetime({ offset: true }),
}).strict();
const publicationPayloadSchema = z.object({
  generation: generationSchema, local_sequence: z.number().int().positive().safe(),
  content_hash: contentHashSchema, byte_count: z.number().int().nonnegative().safe(),
  media_type: z.string().min(1).max(255), completeness: z.enum(["complete", "partial"]),
  storage: z.enum(["worker_local", "cloud_object"]),
}).strict();

export type RemoteWorkerOutboxLease = Readonly<z.infer<typeof leaseSchema>>;
export type RemoteWorkerOutboxEventInput = Readonly<z.input<typeof eventInputSchema>>;
export type RemoteWorkerOutboxPublicationInput = Readonly<z.input<typeof publicationInputSchema>>;
export type RemoteWorkerOutboxState = "pending" | "inflight" | "acked" | "blocked";
export type RemoteWorkerOutboxEntry = Readonly<{
  id: number;
  jobId: string;
  leaseId: string;
  generation: number;
  kind: "event" | "publication";
  dedupeKey: string;
  localSequence: number;
  state: RemoteWorkerOutboxState;
  createdAtMs: number;
  ackedAtMs: number | null;
  blockedCode: string | null;
}>;

type OutboxRow = {
  id: number;
  job_id: string;
  lease_id: string;
  lease_generation: number;
  kind: "event" | "publication";
  dedupe_key: string;
  local_sequence: number;
  payload_json: string;
  payload_hash: Uint8Array;
  state: RemoteWorkerOutboxState;
  created_at_ms: number;
  acked_at_ms: number | null;
  blocked_code: string | null;
};
type DeliveryOptions = Readonly<{
  lease: RemoteWorkerOutboxLease;
  sessionToken: string;
  client: Pick<RemoteWorkerClient, "appendEvent" | "publishResult">;
  signal?: AbortSignal | undefined;
}>;

export class RemoteWorkerOutboxClosedError extends Error {
  constructor() {
    super("The Remote Worker outbox is closed.");
    this.name = "RemoteWorkerOutboxClosedError";
  }
}

export class RemoteWorkerOutboxInputError extends Error {
  constructor() {
    super("The Remote Worker outbox input is invalid.");
    this.name = "RemoteWorkerOutboxInputError";
  }
}

export class RemoteWorkerOutboxIntegrityError extends Error {
  constructor() {
    super("The Remote Worker outbox payload failed its integrity check.");
    this.name = "RemoteWorkerOutboxIntegrityError";
  }
}

export class RemoteWorkerOutboxDedupeConflictError extends Error {
  constructor() {
    super("The Remote Worker outbox dedupe key is already bound to a different payload.");
    this.name = "RemoteWorkerOutboxDedupeConflictError";
  }
}

export class RemoteWorkerOutboxLeaseBlockedError extends Error {
  constructor(readonly code: string) {
    super("The Remote Worker lease generation is blocked.");
    this.name = "RemoteWorkerOutboxLeaseBlockedError";
  }
}

export class RemoteWorkerOutboxOwnershipError extends Error {
  constructor() {
    super("The Remote Worker outbox already has a live owner.");
    this.name = "RemoteWorkerOutboxOwnershipError";
  }
}

export class RemoteWorkerOutboxDeliveryActiveError extends Error {
  constructor() {
    super("The Remote Worker outbox cannot close while delivery is active.");
    this.name = "RemoteWorkerOutboxDeliveryActiveError";
  }
}

export class RemoteWorkerOutboxPathError extends Error {
  constructor() {
    super("The Remote Worker outbox path is not a private owned file location.");
    this.name = "RemoteWorkerOutboxPathError";
  }
}

function parsed<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const result = schema.safeParse(value);
  if (!result.success) throw new RemoteWorkerOutboxInputError();
  return result.data;
}

function canonicalOutboxUsage(value: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function encodedPayload(value: unknown): Readonly<{ json: string; hash: Buffer }> {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maximumPayloadBytes) throw new RemoteWorkerOutboxInputError();
  return Object.freeze({ json, hash: createHash("sha256").update(json).digest() });
}

function entry(row: OutboxRow): RemoteWorkerOutboxEntry {
  return Object.freeze({
    id: row.id,
    jobId: row.job_id,
    leaseId: row.lease_id,
    generation: row.lease_generation,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    localSequence: row.local_sequence,
    state: row.state,
    createdAtMs: row.created_at_ms,
    ackedAtMs: row.acked_at_ms,
    blockedCode: row.blocked_code,
  });
}

function ownedWithMode(path: string, kind: "directory" | "file", mode: number): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  const expectedKind = kind === "directory" ? stat.isDirectory() : stat.isFile();
  const currentUid = process.getuid?.();
  return expectedKind && !stat.isSymbolicLink() && (currentUid === undefined || stat.uid === currentUid) &&
    (stat.mode & 0o777) === mode;
}

function prepareFilePath(path: string): boolean {
  if (!isAbsolute(path)) throw new RemoteWorkerOutboxPathError();
  const parent = dirname(path);
  if (!existsSync(parent)) {
    try {
      mkdirSync(parent, { mode: 0o700 });
    } catch {
      throw new RemoteWorkerOutboxPathError();
    }
  }
  if (!ownedWithMode(parent, "directory", 0o700)) throw new RemoteWorkerOutboxPathError();
  const existing = existsSync(path);
  if (existing && !ownedWithMode(path, "file", 0o600)) throw new RemoteWorkerOutboxPathError();
  return existing;
}

function sqliteLockConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "errcode" in error && ((error as { errcode?: unknown }).errcode === 5 ||
      (error as { errcode?: unknown }).errcode === 6);
}

export class RemoteWorkerOutbox {
  readonly #database: DatabaseSync;
  readonly #deliveries = new Map<string, Promise<void>>();
  #closed = false;

  constructor(path: string, private readonly now: () => number = () => Date.now()) {
    const memory = path === ":memory:";
    const existed = memory ? true : prepareFilePath(path);
    this.#database = new DatabaseSync(path, { timeout: 0 });
    if (!memory && !existed) chmodSync(path, 0o600);
    if (!memory) {
      try {
        this.#database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
      } catch (error) {
        this.#database.close();
        this.#closed = true;
        if (sqliteLockConflict(error)) throw new RemoteWorkerOutboxOwnershipError();
        throw error;
      }
    }
    try {
      this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      const version = this.#database.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 0 && version.user_version !== schemaVersion) {
        throw new Error("The Remote Worker outbox schema version is unsupported.");
      }
      if (version.user_version === 0) {
        this.#database.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE remote_worker_outbox (
            id INTEGER PRIMARY KEY,
            job_id TEXT NOT NULL,
            lease_id TEXT NOT NULL,
            lease_generation INTEGER NOT NULL CHECK(lease_generation > 0),
            kind TEXT NOT NULL CHECK(kind IN ('event', 'publication')),
            dedupe_key TEXT NOT NULL,
            local_sequence INTEGER NOT NULL CHECK(local_sequence > 0),
            payload_json TEXT NOT NULL,
            payload_hash BLOB NOT NULL CHECK(length(payload_hash) = 32),
            state TEXT NOT NULL CHECK(state IN ('pending', 'inflight', 'acked', 'blocked')),
            created_at_ms INTEGER NOT NULL,
            acked_at_ms INTEGER,
            blocked_code TEXT,
            UNIQUE(lease_id, kind, local_sequence),
            UNIQUE(lease_id, kind, dedupe_key)
          ) STRICT;
          CREATE INDEX remote_worker_outbox_delivery
            ON remote_worker_outbox(lease_id, lease_generation, state, id);
          CREATE TABLE remote_worker_blocked_generations (
            job_id TEXT NOT NULL,
            lease_id TEXT NOT NULL,
            lease_generation INTEGER NOT NULL CHECK(lease_generation > 0),
            blocked_code TEXT NOT NULL,
            blocked_at_ms INTEGER NOT NULL,
            PRIMARY KEY(job_id, lease_id, lease_generation)
          ) STRICT;
          PRAGMA user_version = 1;
          COMMIT;
        `);
      }
      this.#database.prepare(`
        UPDATE remote_worker_outbox SET state = 'pending'
        WHERE state = 'inflight'
      `).run();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  enqueueEvent(leaseValue: RemoteWorkerOutboxLease, inputValue: RemoteWorkerOutboxEventInput): RemoteWorkerOutboxEntry {
    const lease = parsed(leaseSchema, leaseValue);
    const input = parsed(eventInputSchema, inputValue);
    return this.#enqueue(lease, "event", input.dedupeKey, (localSequence) => encodedPayload({
      generation: lease.generation,
      local_sequence: localSequence,
      event_type: input.eventType,
      page_status: input.pageStatus,
      error_code: input.errorCode,
      provider: input.provider,
      byte_count: input.byteCount,
      duration_ms: input.durationMs,
      content_hash: input.contentHash,
      usage: canonicalOutboxUsage(input.usage),
      occurred_at: input.occurredAt.toISOString(),
    }));
  }

  enqueuePublication(
    leaseValue: RemoteWorkerOutboxLease,
    inputValue: RemoteWorkerOutboxPublicationInput,
  ): RemoteWorkerOutboxEntry {
    const lease = parsed(leaseSchema, leaseValue);
    const input = parsed(publicationInputSchema, inputValue);
    return this.#enqueue(lease, "publication", input.dedupeKey, (localSequence) => encodedPayload({
      generation: lease.generation,
      local_sequence: localSequence,
      content_hash: input.contentHash,
      byte_count: input.byteCount,
      media_type: input.mediaType,
      completeness: input.completeness,
      storage: input.storage,
    }));
  }

  listPendingLeases(): readonly RemoteWorkerOutboxLease[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT job_id, lease_id, lease_generation
      FROM remote_worker_outbox WHERE state = 'pending'
      GROUP BY job_id, lease_id, lease_generation ORDER BY MIN(id)
    `).all() as Array<{ job_id: string; lease_id: string; lease_generation: number }>;
    return Object.freeze(rows.map((row) => Object.freeze({
      jobId: row.job_id, leaseId: row.lease_id, generation: row.lease_generation,
    })));
  }

  getEntry(
    leaseValue: RemoteWorkerOutboxLease,
    kind: "event" | "publication",
    dedupeKeyValue: string,
  ): RemoteWorkerOutboxEntry | null {
    this.#assertOpen();
    const lease = parsed(leaseSchema, leaseValue);
    const dedupeKey = parsed(dedupeKeySchema, dedupeKeyValue);
    const row = this.#database.prepare(`
      SELECT * FROM remote_worker_outbox
      WHERE job_id = ? AND lease_id = ? AND lease_generation = ? AND kind = ? AND dedupe_key = ?
    `).get(lease.jobId, lease.leaseId, lease.generation, kind, dedupeKey) as OutboxRow | undefined;
    return row === undefined ? null : entry(row);
  }

  listEntries(leaseValue: RemoteWorkerOutboxLease): readonly RemoteWorkerOutboxEntry[] {
    // Result acknowledgements are durable here; terminal response-loss remains outcome-unknown.
    this.#assertOpen();
    const lease = parsed(leaseSchema, leaseValue);
    const rows = this.#database.prepare(`
      SELECT * FROM remote_worker_outbox
      WHERE job_id = ? AND lease_id = ? AND lease_generation = ? ORDER BY id
    `).all(lease.jobId, lease.leaseId, lease.generation) as OutboxRow[];
    return Object.freeze(rows.map(entry));
  }

  blockLeaseGeneration(
    jobIdValue: string,
    leaseIdValue: string,
    generationValue: number,
    codeValue: string,
  ): void {
    this.#assertOpen();
    const lease = parsed(leaseSchema, {
      jobId: jobIdValue, leaseId: leaseIdValue, generation: generationValue,
    });
    const code = parsed(blockedCodeSchema, codeValue);
    this.#transaction(() => { this.#blockInTransaction(lease, code); });
  }

  async deliverNext(options: DeliveryOptions): Promise<RemoteWorkerOutboxEntry | null> {
    this.#assertOpen();
    const lease = parsed(leaseSchema, options.lease);
    const key = `${lease.jobId}\0${lease.leaseId}\0${lease.generation}`;
    return this.#serializeDelivery(key, () => this.#deliverOne(options, lease));
  }

  async #deliverOne(
    options: DeliveryOptions,
    lease: z.infer<typeof leaseSchema>,
  ): Promise<RemoteWorkerOutboxEntry | null> {
    this.#assertOpen();
    const row = this.#transaction(() => {
      const selected = this.#database.prepare(`
        SELECT * FROM remote_worker_outbox
        WHERE job_id = ? AND lease_id = ? AND lease_generation = ? AND state = 'pending'
        ORDER BY id LIMIT 1
      `).get(lease.jobId, lease.leaseId, lease.generation) as OutboxRow | undefined;
      if (selected === undefined) return null;
      const claimed = this.#database.prepare(
        "UPDATE remote_worker_outbox SET state = 'inflight' WHERE id = ? AND state = 'pending'",
      ).run(selected.id);
      if (Number(claimed.changes) !== 1) throw new RemoteWorkerOutboxIntegrityError();
      return { ...selected, state: "inflight" as const };
    });
    if (row === null) return null;
    try {
      const actualHash = createHash("sha256").update(row.payload_json).digest();
      if (!actualHash.equals(Buffer.from(row.payload_hash))) throw new RemoteWorkerOutboxIntegrityError();
      const payloadValue: unknown = JSON.parse(row.payload_json);
      if (row.kind === "event") {
        const payload = parsed(eventPayloadSchema, payloadValue);
        if (payload.generation !== row.lease_generation || payload.local_sequence !== row.local_sequence) {
          throw new RemoteWorkerOutboxIntegrityError();
        }
        await options.client.appendEvent({
          sessionToken: options.sessionToken, leaseId: row.lease_id, expectedJobId: row.job_id,
          generation: payload.generation, localSequence: payload.local_sequence,
          eventType: payload.event_type, pageStatus: payload.page_status, errorCode: payload.error_code,
          provider: payload.provider, byteCount: payload.byte_count, durationMs: payload.duration_ms,
          contentHash: payload.content_hash, usage: payload.usage, occurredAt: new Date(payload.occurred_at),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } else {
        const payload = parsed(publicationPayloadSchema, payloadValue);
        if (payload.generation !== row.lease_generation || payload.local_sequence !== row.local_sequence) {
          throw new RemoteWorkerOutboxIntegrityError();
        }
        await options.client.publishResult({
          sessionToken: options.sessionToken, leaseId: row.lease_id, expectedJobId: row.job_id,
          generation: payload.generation, localSequence: payload.local_sequence,
          contentHash: payload.content_hash, byteCount: payload.byte_count, mediaType: payload.media_type,
          completeness: payload.completeness, storage: payload.storage,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }
      const acknowledged = this.now();
      return this.#transaction(() => {
        const updated = this.#database.prepare(`
          UPDATE remote_worker_outbox
          SET state = 'acked', acked_at_ms = ?, blocked_code = NULL
          WHERE id = ? AND state = 'inflight'
        `).run(acknowledged, row.id);
        if (Number(updated.changes) !== 1) {
          const code = this.#blockedCode(row.job_id, row.lease_id, row.lease_generation);
          if (code !== null) throw new RemoteWorkerOutboxLeaseBlockedError(code);
          throw new RemoteWorkerOutboxIntegrityError();
        }
        return entry({ ...row, state: "acked", acked_at_ms: acknowledged, blocked_code: null });
      });
    } catch (error) {
      this.#transaction(() => {
        if (error instanceof RemoteWorkerHttpError && error.status === 409 &&
            (error.code === "JOB_LEASE_FENCED" || error.code === "JOB_RESULT_IDEMPOTENCY_CONFLICT")) {
          this.#blockInTransaction({
            jobId: row.job_id, leaseId: row.lease_id, generation: row.lease_generation,
          }, error.code);
        } else {
          this.#database.prepare(`
            UPDATE remote_worker_outbox SET state = 'pending' WHERE id = ? AND state = 'inflight'
          `).run(row.id);
        }
      });
      throw error;
    }
  }

  close(): void {
    this.#assertOpen();
    if (this.#deliveries.size > 0) throw new RemoteWorkerOutboxDeliveryActiveError();
    this.#database.close();
    this.#closed = true;
  }

  #enqueue(
    lease: z.infer<typeof leaseSchema>,
    kind: "event" | "publication",
    dedupeKey: string,
    payload: (localSequence: number) => Readonly<{ json: string; hash: Buffer }>,
  ): RemoteWorkerOutboxEntry {
    this.#assertOpen();
    return this.#transaction(() => {
      const binding = this.#database.prepare(`
        SELECT job_id, lease_generation FROM remote_worker_outbox WHERE lease_id = ? LIMIT 1
      `).get(lease.leaseId) as { job_id: string; lease_generation: number } | undefined;
      if (binding !== undefined &&
          (binding.job_id !== lease.jobId || binding.lease_generation !== lease.generation)) {
        throw new RemoteWorkerOutboxInputError();
      }
      const blockedBinding = this.#database.prepare(`
        SELECT job_id, lease_generation FROM remote_worker_blocked_generations
        WHERE lease_id = ? LIMIT 1
      `).get(lease.leaseId) as { job_id: string; lease_generation: number } | undefined;
      if (blockedBinding !== undefined &&
          (blockedBinding.job_id !== lease.jobId || blockedBinding.lease_generation !== lease.generation)) {
        throw new RemoteWorkerOutboxInputError();
      }
      const existing = this.#database.prepare(`
        SELECT * FROM remote_worker_outbox
        WHERE lease_id = ? AND kind = ? AND dedupe_key = ?
      `).get(lease.leaseId, kind, dedupeKey) as OutboxRow | undefined;
      if (existing !== undefined) {
        const expected = payload(existing.local_sequence);
        if (existing.payload_json !== expected.json ||
            !Buffer.from(existing.payload_hash).equals(expected.hash)) {
          throw new RemoteWorkerOutboxDedupeConflictError();
        }
        return entry(existing);
      }
      const blockedCode = this.#blockedCode(lease.jobId, lease.leaseId, lease.generation);
      if (blockedCode !== null) throw new RemoteWorkerOutboxLeaseBlockedError(blockedCode);
      const next = this.#database.prepare(`
        SELECT COALESCE(MAX(local_sequence), 0) + 1 AS local_sequence
        FROM remote_worker_outbox WHERE lease_id = ? AND kind = ?
      `).get(lease.leaseId, kind) as { local_sequence: number };
      if (!Number.isSafeInteger(next.local_sequence)) throw new RemoteWorkerOutboxInputError();
      const encoded = payload(next.local_sequence);
      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new RemoteWorkerOutboxInputError();
      const inserted = this.#database.prepare(`
        INSERT INTO remote_worker_outbox(
          job_id, lease_id, lease_generation, kind, dedupe_key, local_sequence, payload_json,
          payload_hash, state, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING *
      `).get(
        lease.jobId, lease.leaseId, lease.generation, kind, dedupeKey, next.local_sequence,
        encoded.json, encoded.hash, createdAt,
      ) as OutboxRow | undefined;
      if (inserted === undefined) throw new Error("The Remote Worker outbox insert returned no row.");
      return entry(inserted);
    });
  }

  #blockedCode(jobId: string, leaseId: string, generation: number): string | null {
    const row = this.#database.prepare(`
      SELECT blocked_code FROM remote_worker_blocked_generations
      WHERE job_id = ? AND lease_id = ? AND lease_generation = ?
    `).get(jobId, leaseId, generation) as { blocked_code: string } | undefined;
    return row?.blocked_code ?? null;
  }

  #blockInTransaction(lease: z.infer<typeof leaseSchema>, code: string): void {
    const rowBinding = this.#database.prepare(`
      SELECT job_id, lease_generation FROM remote_worker_outbox WHERE lease_id = ? LIMIT 1
    `).get(lease.leaseId) as { job_id: string; lease_generation: number } | undefined;
    const blockBinding = this.#database.prepare(`
      SELECT job_id, lease_generation FROM remote_worker_blocked_generations
      WHERE lease_id = ? LIMIT 1
    `).get(lease.leaseId) as { job_id: string; lease_generation: number } | undefined;
    if ([rowBinding, blockBinding].some((binding) => binding !== undefined &&
        (binding.job_id !== lease.jobId || binding.lease_generation !== lease.generation))) {
      throw new RemoteWorkerOutboxInputError();
    }
    const blockedAt = this.now();
    if (!Number.isSafeInteger(blockedAt) || blockedAt < 0) throw new RemoteWorkerOutboxInputError();
    this.#database.prepare(`
      INSERT INTO remote_worker_blocked_generations(
        job_id, lease_id, lease_generation, blocked_code, blocked_at_ms
      ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, lease_id, lease_generation) DO NOTHING
    `).run(lease.jobId, lease.leaseId, lease.generation, code, blockedAt);
    const storedCode = this.#blockedCode(lease.jobId, lease.leaseId, lease.generation);
    if (storedCode === null) throw new RemoteWorkerOutboxIntegrityError();
    this.#database.prepare(`
      UPDATE remote_worker_outbox SET state = 'blocked', blocked_code = ?
      WHERE job_id = ? AND lease_id = ? AND lease_generation = ?
        AND state IN ('pending', 'inflight')
    `).run(storedCode, lease.jobId, lease.leaseId, lease.generation);
  }

  async #serializeDelivery<Value>(key: string, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#deliveries.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#deliveries.set(key, current);
    try {
      if (previous !== undefined) await previous;
      return await operation();
    } finally {
      release();
      if (this.#deliveries.get(key) === current) this.#deliveries.delete(key);
    }
  }

  #transaction<Value>(operation: () => Value): Value {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new RemoteWorkerOutboxClosedError();
  }
}
