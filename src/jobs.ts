import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeError, ReadError } from "./errors.js";
import type { SiteService } from "./site.js";
import type {
  CrawlJob,
  CrawlJobError,
  CrawlJobStatus,
  CrawlSiteOptions,
  CrawlSiteResult,
  AttemptInput,
  AttemptProjection,
  AttemptRecord,
  ResourceUsage,
} from "./types.js";

type AttemptRow = {
  id: string;
  request_id: string;
  sequence: number;
  plan_id: string;
  stage_id: string;
  provider: AttemptRecord["provider"];
  provider_version: string;
  outcome: AttemptRecord["outcome"];
  raw_ref: string | null;
  trace_ref: string | null;
  error_code: AttemptRecord["errorCode"];
  usage_json: string;
  started_at: string;
  completed_at: string;
  recorded_at: string;
};

const attemptUsageFields = [
  "documentBytesIn",
  "networkBytesOut",
  "browserMilliseconds",
  "browserContextStarts",
  "retryDelayMilliseconds",
  "optionalModelTokens",
] as const satisfies ReadonlyArray<keyof ResourceUsage>;

function requireNonempty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
}

function validateAttempt(input: AttemptInput): void {
  requireNonempty(input.requestId, "requestId");
  requireNonempty(input.planId, "planId");
  requireNonempty(input.stageId, "stageId");
  requireNonempty(input.providerVersion, "providerVersion");
  for (const field of attemptUsageFields) {
    if (!Number.isFinite(input.usage[field]) || input.usage[field] < 0) {
      throw new Error(`usage.${field} must be a finite non-negative number`);
    }
  }
  for (const field of [
    "documentBytesIn", "networkBytesOut", "browserContextStarts", "optionalModelTokens",
  ] as const) {
    if (!Number.isSafeInteger(input.usage[field])) {
      throw new Error(`usage.${field} must be an integer`);
    }
  }
  const started = Date.parse(input.startedAt);
  const completed = Date.parse(input.completedAt);
  if (!Number.isFinite(started)) throw new Error("startedAt must be an ISO timestamp");
  if (!Number.isFinite(completed) || completed < started) {
    throw new Error("completedAt must be an ISO timestamp at or after startedAt");
  }
  if (input.outcome === "succeeded" && input.errorCode !== null) {
    throw new Error("successful attempts cannot have errorCode");
  }
  if (input.outcome === "failed" && input.errorCode === null) {
    throw new Error("failed attempts require errorCode");
  }
}

function attemptFromRow(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    sequence: row.sequence,
    planId: row.plan_id,
    stageId: row.stage_id,
    provider: row.provider,
    providerVersion: row.provider_version,
    outcome: row.outcome,
    rawRef: row.raw_ref,
    traceRef: row.trace_ref,
    errorCode: row.error_code,
    usage: JSON.parse(row.usage_json) as ResourceUsage,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    recordedAt: row.recorded_at,
  };
}

function emptyAttemptUsage(): ResourceUsage {
  return {
    documentBytesIn: 0,
    networkBytesOut: 0,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryDelayMilliseconds: 0,
    optionalModelTokens: 0,
  };
}

export class AttemptLedger {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly now: () => number = () => Date.now()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS execution_attempts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        plan_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_version TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed', 'stopped', 'cancelled')),
        raw_ref TEXT,
        trace_ref TEXT,
        error_code TEXT,
        usage_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(request_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS execution_attempts_request
      ON execution_attempts(request_id, sequence);
    `);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  append(input: AttemptInput): AttemptRecord {
    validateAttempt(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.database
        .prepare("SELECT MAX(sequence) AS sequence FROM execution_attempts WHERE request_id = ?")
        .get(input.requestId) as { sequence: number | null };
      const record: AttemptRecord = {
        ...input,
        id: randomUUID(),
        sequence: (previous.sequence ?? 0) + 1,
        recordedAt: new Date(this.now()).toISOString(),
      };
      this.database.prepare(`
        INSERT INTO execution_attempts(
          id, request_id, sequence, plan_id, stage_id, provider, provider_version,
          outcome, raw_ref, trace_ref, error_code, usage_json, started_at,
          completed_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.requestId, record.sequence, record.planId, record.stageId,
        record.provider, record.providerVersion, record.outcome, record.rawRef,
        record.traceRef, record.errorCode, JSON.stringify(record.usage), record.startedAt,
        record.completedAt, record.recordedAt,
      );
      this.database.exec("COMMIT");
      return record;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  list(requestId: string): AttemptRecord[] {
    requireNonempty(requestId, "requestId");
    const rows = this.database.prepare(
      "SELECT * FROM execution_attempts WHERE request_id = ? ORDER BY sequence",
    ).all(requestId) as unknown as AttemptRow[];
    return rows.map(attemptFromRow);
  }

  project(requestId: string): AttemptProjection | null {
    const attempts = this.list(requestId);
    const last = attempts.at(-1);
    if (last === undefined) return null;
    const usage = emptyAttemptUsage();
    for (const attempt of attempts) {
      for (const field of attemptUsageFields) usage[field] += attempt.usage[field];
    }
    return {
      requestId,
      attempts: attempts.length,
      lastSequence: last.sequence,
      lastOutcome: last.outcome,
      lastStageId: last.stageId,
      usage,
    };
  }

  close(): void {
    this.database.close();
  }
}

type JobRow = {
  id: string;
  status: CrawlJobStatus;
  input_json: string;
  created_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  result_json: string | null;
  error_json: string | null;
  cancel_requested: number;
};

type CrawlExecutor = Pick<SiteService, "crawlSite">;

function isoTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function rowToJob(row: JobRow): CrawlJob {
  return {
    id: row.id,
    status: row.status,
    input: JSON.parse(row.input_json) as CrawlSiteOptions,
    createdAt: new Date(row.created_at_ms).toISOString(),
    startedAt: isoTime(row.started_at_ms),
    completedAt: isoTime(row.completed_at_ms),
    result: row.result_json === null
      ? null
      : JSON.parse(row.result_json) as CrawlSiteResult,
    error: row.error_json === null
      ? null
      : JSON.parse(row.error_json) as CrawlJobError,
  };
}

export class CrawlJobStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS crawl_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        input_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        result_json TEXT,
        error_json TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS crawl_jobs_queue
      ON crawl_jobs(status, created_at_ms);
    `);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
  }

  create(input: CrawlSiteOptions): CrawlJob {
    const id = randomUUID();
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO crawl_jobs(id, status, input_json, created_at_ms)
         VALUES (?, 'queued', ?, ?)`,
      )
      .run(id, JSON.stringify(input), now);
    return this.require(id);
  }

  get(id: string): CrawlJob | null {
    const row = this.database.prepare("SELECT * FROM crawl_jobs WHERE id = ?").get(id) as
      | JobRow
      | undefined;
    return row === undefined ? null : rowToJob(row);
  }

  require(id: string): CrawlJob {
    const job = this.get(id);
    if (job === null) {
      throw new ReadError("JOB_NOT_FOUND", "The crawl job does not exist.", {
        details: { jobId: id },
      });
    }
    return job;
  }

  claimNext(): CrawlJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare("SELECT id FROM crawl_jobs WHERE status = 'queued' ORDER BY created_at_ms, id LIMIT 1")
        .get() as { id: string } | undefined;
      if (row === undefined) {
        this.database.exec("COMMIT");
        return null;
      }
      const changed = this.database
        .prepare(
          `UPDATE crawl_jobs
           SET status = 'running', started_at_ms = ?, completed_at_ms = NULL,
               result_json = NULL, error_json = NULL
           WHERE id = ? AND status = 'queued'`,
        )
        .run(Date.now(), row.id).changes;
      this.database.exec("COMMIT");
      return changed === 1 ? this.require(row.id) : null;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  complete(id: string, result: CrawlSiteResult): CrawlJob {
    this.finish(id, "completed", JSON.stringify(result), null);
    return this.require(id);
  }

  fail(id: string, error: CrawlJobError): CrawlJob {
    this.finish(id, "failed", null, JSON.stringify(error));
    return this.require(id);
  }

  markCancelled(id: string): CrawlJob {
    this.finish(id, "cancelled", null, null);
    return this.require(id);
  }

  requestCancel(id: string): CrawlJob {
    const job = this.require(id);
    if (job.status === "queued") {
      return this.markCancelled(id);
    }
    if (job.status === "running") {
      this.database
        .prepare("UPDATE crawl_jobs SET cancel_requested = 1 WHERE id = ? AND status = 'running'")
        .run(id);
    }
    return this.require(id);
  }

  isCancelRequested(id: string): boolean {
    const row = this.database
      .prepare("SELECT cancel_requested FROM crawl_jobs WHERE id = ?")
      .get(id) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  hasQueued(): boolean {
    return this.database
      .prepare("SELECT 1 AS present FROM crawl_jobs WHERE status = 'queued' LIMIT 1")
      .get() !== undefined;
  }

  requeue(id: string): void {
    this.database
      .prepare(
        `UPDATE crawl_jobs
         SET status = 'queued', started_at_ms = NULL, completed_at_ms = NULL,
             result_json = NULL, error_json = NULL
         WHERE id = ? AND status = 'running'`,
      )
      .run(id);
  }

  recoverInterrupted(): void {
    const now = Date.now();
    this.database
      .prepare(
        `UPDATE crawl_jobs
         SET status = 'cancelled', completed_at_ms = ?, cancel_requested = 0
         WHERE status = 'running' AND cancel_requested = 1`,
      )
      .run(now);
    this.database.exec(`
      UPDATE crawl_jobs
      SET status = 'queued', started_at_ms = NULL, completed_at_ms = NULL,
          result_json = NULL, error_json = NULL
      WHERE status = 'running';
    `);
  }

  close(): void {
    this.database.close();
  }

  private finish(
    id: string,
    status: "completed" | "failed" | "cancelled",
    resultJson: string | null,
    errorJson: string | null,
  ): void {
    const changed = this.database
      .prepare(
        `UPDATE crawl_jobs
         SET status = ?, completed_at_ms = ?, result_json = ?, error_json = ?, cancel_requested = 0
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(status, Date.now(), resultJson, errorJson, id).changes;
    if (changed !== 1) {
      const job = this.require(id);
      throw new ReadError("INTERNAL_ERROR", "The crawl job changed state unexpectedly.", {
        details: { jobId: id, jobStatus: job.status, requestedStatus: status },
      });
    }
  }

}

export class CrawlJobService {
  private worker: Promise<void> | null = null;
  private current: { id: string; controller: AbortController } | null = null;
  private workerFailure: ReadError | null = null;
  private closing = false;

  constructor(
    private readonly store: CrawlJobStore,
    private readonly executor: CrawlExecutor,
    private readonly active = true,
  ) {
    if (this.active) {
      this.store.recoverInterrupted();
      this.wake();
    }
  }

  start(input: CrawlSiteOptions): CrawlJob {
    this.throwIfWorkerFailed();
    if (this.closing) {
      throw new ReadError("INTERNAL_ERROR", "The crawl worker is shutting down.");
    }
    if (!this.active) {
      throw new ReadError("INTERNAL_ERROR", "The crawl worker is not active in this process.");
    }
    const job = this.store.create(input);
    this.wake();
    return job;
  }

  get(id: string): CrawlJob {
    this.throwIfWorkerFailed();
    return this.store.require(id);
  }

  cancel(id: string): CrawlJob {
    this.throwIfWorkerFailed();
    const job = this.store.requestCancel(id);
    if (job.status === "running" && this.current?.id === id) {
      this.current.controller.abort();
    }
    return this.store.require(id);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.current?.controller.abort();
    await this.worker;
    this.store.close();
    if (this.workerFailure !== null) {
      throw this.workerFailure;
    }
  }

  private wake(): void {
    if (this.closing || this.worker !== null) {
      return;
    }
    this.worker = this.drain()
      .catch((error: unknown) => {
        this.workerFailure = normalizeError(error);
      })
      .finally(() => {
        this.worker = null;
        if (!this.closing && this.workerFailure === null && this.store.hasQueued()) {
          this.wake();
        }
      });
  }

  private async drain(): Promise<void> {
    while (!this.closing) {
      const job = this.store.claimNext();
      if (job === null) return;
      const controller = new AbortController();
      this.current = { id: job.id, controller };
      try {
        const result = await this.executor.crawlSite({ ...job.input, signal: controller.signal });
        if (this.closing) this.store.requeue(job.id);
        else if (controller.signal.aborted || this.store.isCancelRequested(job.id)) {
          this.store.markCancelled(job.id);
        } else this.store.complete(job.id, result);
      } catch (error) {
        if (this.closing) this.store.requeue(job.id);
        else if (controller.signal.aborted || this.store.isCancelRequested(job.id)) {
          this.store.markCancelled(job.id);
        } else {
          const normalized = normalizeError(error);
          this.store.fail(job.id, {
            code: normalized.code,
            message: normalized.message,
            retryable: normalized.retryable,
            details: normalized.details,
          });
        }
      } finally {
        this.current = null;
      }
    }
  }

  private throwIfWorkerFailed(): void {
    if (this.workerFailure !== null) throw this.workerFailure;
  }
}
