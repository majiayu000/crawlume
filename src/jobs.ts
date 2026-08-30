import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import type {
  AttemptInput,
  AttemptProjection,
  AttemptRecord,
  RequestTerminalInput,
  RequestTerminalProjection,
  ResourceUsage,
} from "./types.js";

type TerminalRow = {
  request_id: string;
  plan_id: string;
  state: RequestTerminalProjection["state"];
  artifact_key: string | null;
  content_hash: string | null;
  validator_version: string | null;
  error_json: string | null;
  publication_key: string | null;
  committed_at: string;
};

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

function terminalFromRow(row: TerminalRow): RequestTerminalProjection {
  return {
    requestId: row.request_id,
    planId: row.plan_id,
    state: row.state,
    artifactKey: row.artifact_key,
    contentHash: row.content_hash,
    validatorVersion: row.validator_version,
    error: row.error_json === null
      ? null
      : JSON.parse(row.error_json) as RequestTerminalProjection["error"],
    publicationKey: row.publication_key,
    committedAt: row.committed_at,
  };
}

function validateTerminal(input: RequestTerminalInput): void {
  requireNonempty(input.requestId, "requestId");
  requireNonempty(input.planId, "planId");
  const completed = input.state === "completed" || input.state === "completed_uncertain";
  if (completed) {
    if (
      input.artifactKey === null || input.contentHash === null ||
      input.validatorVersion === null || input.error !== null
    ) {
      throw new Error("completed terminal outcomes require one artifact and no error");
    }
  } else if (
    input.artifactKey !== null || input.contentHash !== null ||
    input.validatorVersion !== null || input.error === null
  ) {
    throw new Error("non-completed terminal outcomes require one error and no artifact");
  }
}

function publicationKey(input: RequestTerminalInput): string | null {
  if (input.contentHash === null || input.validatorVersion === null) return null;
  return `publication:${createHash("sha256").update(JSON.stringify({
    requestId: input.requestId,
    contentHash: input.contentHash,
    validatorVersion: input.validatorVersion,
  })).digest("hex")}`;
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
      CREATE TABLE IF NOT EXISTS execution_request_terminals (
        request_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'completed','completed_uncertain','invalid','failed','policy_stop','budget_exhausted','cancelled'
        )),
        artifact_key TEXT,
        content_hash TEXT,
        validator_version TEXT,
        error_json TEXT,
        publication_key TEXT UNIQUE,
        committed_at TEXT NOT NULL
      ) STRICT;
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

  getTerminal(requestId: string, planId?: string): RequestTerminalProjection | null {
    requireNonempty(requestId, "requestId");
    const row = this.database.prepare(
      "SELECT * FROM execution_request_terminals WHERE request_id = ?",
    ).get(requestId) as TerminalRow | undefined;
    if (row === undefined) return null;
    if (planId !== undefined && row.plan_id !== planId) {
      throw new ReadError(
        "INVALID_ARGUMENT",
        "The requestId is already bound to a different access plan.",
        { details: { requestId, planId, existingPlanId: row.plan_id } },
      );
    }
    return terminalFromRow(row);
  }

  commitTerminal(input: RequestTerminalInput): RequestTerminalProjection {
    validateTerminal(input);
    const key = publicationKey(input);
    const committedAt = new Date(this.now()).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(
        "SELECT * FROM execution_request_terminals WHERE request_id = ?",
      ).get(input.requestId) as TerminalRow | undefined;
      if (existing !== undefined) {
        const projection = terminalFromRow(existing);
        const expected = { ...input, publicationKey: key };
        const actual = {
          requestId: projection.requestId,
          planId: projection.planId,
          state: projection.state,
          artifactKey: projection.artifactKey,
          contentHash: projection.contentHash,
          validatorVersion: projection.validatorVersion,
          error: projection.error,
          publicationKey: projection.publicationKey,
        };
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new ReadError(
            "INVALID_ARGUMENT",
            "The requestId already has a different terminal outcome.",
            { details: { requestId: input.requestId } },
          );
        }
        this.database.exec("COMMIT");
        return projection;
      }
      this.database.prepare(`
        INSERT INTO execution_request_terminals(
          request_id, plan_id, state, artifact_key, content_hash, validator_version,
          error_json, publication_key, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.requestId,
        input.planId,
        input.state,
        input.artifactKey,
        input.contentHash,
        input.validatorVersion,
        input.error === null ? null : JSON.stringify(input.error),
        key,
        committedAt,
      );
      this.database.exec("COMMIT");
      return this.getTerminal(input.requestId, input.planId) as RequestTerminalProjection;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
      terminal: this.getTerminal(requestId),
    };
  }

  close(): void {
    this.database.close();
  }
}
