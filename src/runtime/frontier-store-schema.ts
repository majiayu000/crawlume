import type { DatabaseSync } from "node:sqlite";

import { ReadError } from "../errors.js";
import type { CrawlBudget, CrawlResourceUsage, ExecutionBudget } from "../types.js";
import {
  emptyCrawlResourceUsage,
  reserveCrawlResources,
  settleCrawlResources,
  type CrawlReservationResult,
  type CrawlSettlementResult,
} from "./resource-governor.js";

export const emptyUsageJson = JSON.stringify(emptyCrawlResourceUsage());

export type PersistedResourceRow = {
  budget_json: string;
  usage_json: string;
  reserved_usage_json: string;
  deadline_at_ms: number;
  created_at_ms: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function initialCrawlResources(input: {
  crawlBudget?: CrawlBudget;
  concurrency?: number;
  originalInput: unknown;
  maxPages: number;
  now: number;
}): {
  budget: CrawlBudget;
  concurrency: number;
  deadlineAtMs: number;
  usage: CrawlResourceUsage;
  reserved: CrawlResourceUsage;
} {
  const raw = record(input.originalInput);
  const budget = input.crawlBudget ?? raw?.crawlBudget as CrawlBudget | undefined ?? {
    maxDurationMs: 86_400_000,
    maxProviderAttempts: input.maxPages,
    maxDocumentBytes: input.maxPages * 50_000_000,
    maxBrowserMs: 0,
    maxBrowserContexts: 0,
  };
  const concurrency = Number(input.concurrency ?? raw?.concurrency ?? 1);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new ReadError("INVALID_ARGUMENT", "concurrency must be between 1 and 32.");
  }
  const deadlineAtMs = input.now + budget.maxDurationMs;
  if (!Number.isSafeInteger(deadlineAtMs)) {
    throw new ReadError("INVALID_ARGUMENT", "crawl deadline exceeds the safe integer range.");
  }
  const usage = emptyCrawlResourceUsage();
  reserveCrawlResources({
    budget,
    usage,
    reserved: usage,
    requested: {
      deadlineMs: budget.maxDurationMs,
      maxAttempts: 1,
      maxDocumentBytes: 0,
      maxBrowserMs: 0,
      maxBrowserContexts: 0,
      maxOptionalModelTokens: 0,
    },
    elapsedMs: 0,
  });
  return { budget, concurrency, deadlineAtMs, usage, reserved: emptyCrawlResourceUsage() };
}

export function parseResources(row: PersistedResourceRow): {
  budget: CrawlBudget;
  usage: CrawlResourceUsage;
  reserved: CrawlResourceUsage;
} {
  return {
    budget: JSON.parse(row.budget_json) as CrawlBudget,
    usage: JSON.parse(row.usage_json) as CrawlResourceUsage,
    reserved: JSON.parse(row.reserved_usage_json) as CrawlResourceUsage,
  };
}

export function requestedPageBudget(
  explicit: ExecutionBudget | undefined,
  originalInput: unknown,
  budget: CrawlBudget,
): ExecutionBudget {
  const fromInput = record(originalInput)?.budget as ExecutionBudget | undefined;
  return explicit ?? fromInput ?? {
    deadlineMs: budget.maxDurationMs,
    maxAttempts: 1,
    maxDocumentBytes: budget.maxDocumentBytes,
    maxBrowserMs: budget.maxBrowserMs,
    maxBrowserContexts: budget.maxBrowserContexts > 0 ? 1 : 0,
    maxOptionalModelTokens: 0,
  };
}

export function reservePersistedResources(
  row: PersistedResourceRow,
  requested: ExecutionBudget,
  now: number,
): CrawlReservationResult {
  const resources = parseResources(row);
  const remainingDuration = Math.max(0, row.deadline_at_ms - now);
  return reserveCrawlResources({
    ...resources,
    requested,
    elapsedMs: Math.max(0, resources.budget.maxDurationMs - remainingDuration),
  });
}

export function settlePersistedResources(
  row: PersistedResourceRow,
  reservation: CrawlResourceUsage,
  actual: CrawlResourceUsage = emptyCrawlResourceUsage(),
): CrawlSettlementResult {
  return settleCrawlResources({ ...parseResources(row), reservation, actual });
}

export function isBudgetExhausted(error: unknown): error is ReadError {
  return error instanceof ReadError && error.code === "BUDGET_EXHAUSTED";
}

export function stopQueuedForError(
  database: DatabaseSync,
  id: string,
  error: unknown,
  now: number,
): void {
  const pages = database.prepare(`
    SELECT id FROM crawl_frontier WHERE crawl_id = ? AND state = 'queued'
    ORDER BY discovery_sequence
  `).all(id) as unknown as Array<{ id: string }>;
  const job = database.prepare(`
    SELECT next_publication_sequence AS sequence FROM crawl_jobs WHERE id = ?
  `).get(id) as { sequence: number };
  const stop = database.prepare(`
    UPDATE crawl_frontier SET state = 'stopped', error_json = ?, publication_sequence = ?,
      completed_at_ms = ?, reserved_usage_json = ? WHERE id = ? AND state = 'queued'
  `);
  const errorJson = JSON.stringify(error);
  for (const [index, page] of pages.entries()) {
    stop.run(errorJson, job.sequence + index, now, emptyUsageJson, page.id);
  }
  database.prepare(`
    UPDATE crawl_jobs SET status = 'failed', error_json = ?, completed_at_ms = ?,
      queued_count = queued_count - ?, stopped_count = stopped_count + ?,
      published_count = published_count + ?, next_publication_sequence = next_publication_sequence + ?
    WHERE id = ?
  `).run(errorJson, now, pages.length, pages.length, pages.length, pages.length, id);
}

export function persistOriginBackoff(
  database: DatabaseSync,
  crawlId: string,
  origin: string,
  untilMs: number,
): void {
  if (!Number.isSafeInteger(untilMs) || untilMs < 0) {
    throw new ReadError("INVALID_ARGUMENT", "origin backoff must be a non-negative safe integer.");
  }
  database.prepare(`
    INSERT INTO crawl_origin_state(crawl_id, origin, backoff_until_ms, version)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(crawl_id, origin) DO UPDATE SET
      backoff_until_ms = MAX(crawl_origin_state.backoff_until_ms, excluded.backoff_until_ms),
      version = crawl_origin_state.version + 1
  `).run(crawlId, origin, untilMs);
}

export function persistLeasedOriginStart(
  database: DatabaseSync,
  lease: { page: { id: string; crawlId: string; origin: string }; owner: string; generation: number },
  intervalMs: number,
  now: number,
): boolean {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new ReadError("INVALID_ARGUMENT", "origin interval must be a non-negative safe integer.");
  }
  const nextAllowedAtMs = now + intervalMs;
  if (!Number.isSafeInteger(nextAllowedAtMs)) {
    throw new ReadError("INVALID_ARGUMENT", "origin start slot exceeds the safe integer range.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const active = database.prepare(`
      SELECT 1 FROM crawl_frontier
      WHERE id = ? AND crawl_id = ? AND origin = ? AND state = 'leased'
        AND lease_owner = ? AND lease_generation = ?
    `).get(
      lease.page.id,
      lease.page.crawlId,
      lease.page.origin,
      lease.owner,
      lease.generation,
    );
    if (active === undefined) {
      database.exec("COMMIT");
      return false;
    }
    database.prepare(`
      INSERT INTO crawl_origin_state(crawl_id, origin, next_allowed_at_ms, version)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(crawl_id, origin) DO UPDATE SET
        next_allowed_at_ms = MAX(crawl_origin_state.next_allowed_at_ms, excluded.next_allowed_at_ms),
        version = crawl_origin_state.version + 1
    `).run(lease.page.crawlId, lease.page.origin, nextAllowedAtMs);
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const crawlJobsSchema = `
  CREATE TABLE IF NOT EXISTS crawl_jobs (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('queued','running','paused','completed','failed','cancelled')),
    input_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    result_json TEXT,
    error_json TEXT,
    worker_owner TEXT,
    deadline_at_ms INTEGER,
    concurrency INTEGER NOT NULL DEFAULT 1,
    max_pages INTEGER NOT NULL DEFAULT 1 CHECK(max_pages > 0),
    budget_json TEXT NOT NULL DEFAULT '{}',
    usage_json TEXT NOT NULL DEFAULT '{}',
    reserved_usage_json TEXT NOT NULL DEFAULT '{}',
    discovered_count INTEGER NOT NULL DEFAULT 0,
    queued_count INTEGER NOT NULL DEFAULT 0,
    leased_count INTEGER NOT NULL DEFAULT 0,
    succeeded_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    stopped_count INTEGER NOT NULL DEFAULT 0,
    published_count INTEGER NOT NULL DEFAULT 0,
    next_publication_sequence INTEGER NOT NULL DEFAULT 1,
    pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1)),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS crawl_jobs_queue ON crawl_jobs(status, created_at_ms);
`;

function migrateLegacyJobs(database: DatabaseSync, now: number): void {
  const unsupported = JSON.stringify({
    code: "UNSUPPORTED",
    message: "Legacy active crawl jobs cannot be resumed without a page frontier.",
  });
  database.exec(`
    ALTER TABLE crawl_jobs RENAME TO crawl_jobs_legacy_frontier;
    DROP INDEX IF EXISTS crawl_jobs_queue;
  `);
  database.exec(crawlJobsSchema);
  database.prepare(`
    INSERT INTO crawl_jobs(
      id, schema_version, status, input_json, created_at_ms, started_at_ms,
      completed_at_ms, result_json, error_json, max_pages, budget_json, usage_json,
      reserved_usage_json, cancel_requested
    )
    SELECT id, 1,
      CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,
      input_json, created_at_ms, started_at_ms,
      CASE WHEN status IN ('queued','running') THEN ? ELSE completed_at_ms END,
      result_json,
      CASE WHEN status IN ('queued','running') THEN ? ELSE error_json END,
      1, '{}', ?, ?, cancel_requested
    FROM crawl_jobs_legacy_frontier
  `).run(now, unsupported, emptyUsageJson, emptyUsageJson);
  database.exec("DROP TABLE crawl_jobs_legacy_frontier");
}

export function migrateFrontierSchema(database: DatabaseSync, now: () => number): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS frontier_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
  const current = database.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM frontier_schema_migrations",
  ).get() as { version: number };

  database.exec("BEGIN IMMEDIATE");
  try {
    if (current.version < 1) {
      const columns = database.prepare("PRAGMA table_info(crawl_jobs)").all() as unknown as
        Array<{ name: string }>;
      if (columns.length > 0 && !columns.some((column) => column.name === "schema_version")) {
        migrateLegacyJobs(database, now());
      } else {
        database.exec(crawlJobsSchema);
      }
      database.prepare(
        "INSERT INTO frontier_schema_migrations(version, applied_at_ms) VALUES (1, ?)",
      ).run(now());
    }
    if (current.version < 2) {
      database.exec(`
        CREATE TABLE crawl_frontier (
          id TEXT PRIMARY KEY,
          crawl_id TEXT NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
          requested_url TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          origin TEXT NOT NULL,
          depth INTEGER NOT NULL CHECK(depth >= 0),
          discovered_from TEXT,
          discovery_sequence INTEGER NOT NULL CHECK(discovery_sequence > 0),
          state TEXT NOT NULL CHECK(state IN ('queued','leased','succeeded','failed','stopped')),
          next_eligible_at_ms INTEGER NOT NULL,
          lease_owner TEXT,
          lease_expires_at_ms INTEGER,
          lease_generation INTEGER NOT NULL DEFAULT 0,
          execution_count INTEGER NOT NULL DEFAULT 0,
          reserved_usage_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT,
          error_json TEXT,
          publication_sequence INTEGER,
          created_at_ms INTEGER NOT NULL,
          started_at_ms INTEGER,
          completed_at_ms INTEGER,
          UNIQUE(crawl_id, normalized_url),
          UNIQUE(crawl_id, discovery_sequence),
          UNIQUE(crawl_id, publication_sequence)
        ) STRICT;
        CREATE INDEX crawl_frontier_claim
        ON crawl_frontier(crawl_id, state, next_eligible_at_ms, discovery_sequence);
        CREATE INDEX crawl_frontier_publication
        ON crawl_frontier(crawl_id, publication_sequence);
        CREATE INDEX crawl_frontier_expiry
        ON crawl_frontier(state, lease_expires_at_ms);
        CREATE TABLE crawl_origin_state (
          crawl_id TEXT NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
          origin TEXT NOT NULL,
          next_allowed_at_ms INTEGER NOT NULL DEFAULT 0,
          backoff_until_ms INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(crawl_id, origin)
        ) STRICT;
      `);
      database.prepare(
        "INSERT INTO frontier_schema_migrations(version, applied_at_ms) VALUES (2, ?)",
      ).run(now());
    }
    if (current.version < 3) {
      const rows = database.prepare(`
        SELECT id, input_json, max_pages, created_at_ms, budget_json, usage_json
        FROM crawl_jobs
      `).all() as unknown as Array<{
        id: string;
        input_json: string;
        max_pages: number;
        created_at_ms: number;
        budget_json: string;
        usage_json: string;
      }>;
      const update = database.prepare(`
        UPDATE crawl_jobs SET concurrency = ?, deadline_at_ms = ?, budget_json = ?,
          usage_json = ?, reserved_usage_json = ? WHERE id = ?
      `);
      for (const row of rows) {
        const budget = JSON.parse(row.budget_json) as Partial<CrawlBudget>;
        const usage = JSON.parse(row.usage_json) as Partial<CrawlResourceUsage>;
        if (Number.isSafeInteger(budget.maxDurationMs) &&
            Number.isSafeInteger(usage.providerAttempts)) continue;
        const originalInput = JSON.parse(row.input_json) as unknown;
        const resources = initialCrawlResources({
          originalInput,
          maxPages: row.max_pages,
          now: row.created_at_ms,
        });
        update.run(
          resources.concurrency, resources.deadlineAtMs, JSON.stringify(resources.budget),
          JSON.stringify(resources.usage), JSON.stringify(resources.reserved), row.id,
        );
        database.prepare(
          "UPDATE crawl_frontier SET reserved_usage_json = ? WHERE crawl_id = ?",
        ).run(emptyUsageJson, row.id);
      }
      database.prepare(
        "INSERT INTO frontier_schema_migrations(version, applied_at_ms) VALUES (3, ?)",
      ).run(now());
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
