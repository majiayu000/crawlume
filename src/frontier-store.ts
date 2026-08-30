import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  emptyUsageJson,
  initialCrawlResources,
  isBudgetExhausted,
  migrateFrontierSchema,
  parseResources,
  persistLeasedOriginStart,
  persistOriginBackoff,
  requestedPageBudget,
  reservePersistedResources,
  settlePersistedResources,
  stopQueuedForError,
  type PersistedResourceRow,
} from "./runtime/frontier-store-schema.js";
import { emptyCrawlResourceUsage } from "./runtime/resource-governor.js";
import type {
  EnqueueCandidate,
  EnqueueResult,
  FrontierJob,
  FrontierLease,
  FrontierPage,
  FrontierPublicationBatch,
  FrontierProgress,
} from "./runtime/frontier.js";
import { canTransitionFrontierJob } from "./runtime/frontier.js";
import type { CrawlBudget, CrawlResourceUsage, ExecutionBudget } from "./types.js";

type JobRow = PersistedResourceRow & {
  id: string;
  status: FrontierJob["status"];
  input_json: string;
  max_pages: number;
  created_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  discovered_count: number;
  queued_count: number;
  leased_count: number;
  succeeded_count: number;
  failed_count: number;
  stopped_count: number;
  published_count: number;
  pause_requested: number;
  cancel_requested: number;
  truncated: number;
  concurrency: number;
  error_json: string | null;
  next_publication_sequence: number;
};

type PageRow = {
  id: string;
  crawl_id: string;
  requested_url: string;
  normalized_url: string;
  origin: string;
  depth: number;
  discovered_from: string | null;
  discovery_sequence: number;
  state: FrontierPage["state"];
  next_eligible_at_ms: number;
  execution_count: number;
  created_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  reserved_usage_json: string;
};

export type EnqueueFrontierInput = EnqueueCandidate & { crawlId: string };
export type ClaimFrontierInput = {
  crawlId: string;
  owner: string;
  leaseMs: number;
  requestedBudget?: ExecutionBudget;
  originIntervalMs?: number;
};

export type CreateFrontierJobInput = {
  id?: string;
  rootUrl: string;
  maxPages: number;
  input?: unknown;
  crawlBudget?: CrawlBudget;
  concurrency?: number;
};

function progressFromRow(row: JobRow): FrontierProgress {
  return {
    discovered: row.discovered_count,
    queued: row.queued_count,
    leased: row.leased_count,
    succeeded: row.succeeded_count,
    failed: row.failed_count,
    stopped: row.stopped_count,
    published: row.published_count,
  };
}

function jobFromRow(row: JobRow): FrontierJob {
  const resources = parseResources(row);
  return {
    id: row.id,
    status: row.status,
    input: JSON.parse(row.input_json) as unknown,
    maxPages: row.max_pages,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms,
    progress: progressFromRow(row),
    pauseRequested: row.pause_requested === 1,
    cancelRequested: row.cancel_requested === 1,
    truncated: row.truncated === 1,
    concurrency: row.concurrency,
    budget: resources.budget,
    deadlineAtMs: row.deadline_at_ms,
    usage: resources.usage,
    reservedUsage: resources.reserved,
    error: row.error_json === null ? null : JSON.parse(row.error_json) as unknown,
  };
}

function pageFromRow(row: PageRow): FrontierPage {
  return {
    id: row.id,
    crawlId: row.crawl_id,
    requestedUrl: row.requested_url,
    normalizedUrl: row.normalized_url,
    origin: row.origin,
    depth: row.depth,
    discoveredFrom: row.discovered_from,
    discoverySequence: row.discovery_sequence,
    state: row.state,
    nextEligibleAtMs: row.next_eligible_at_ms,
    executionCount: row.execution_count,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms,
  };
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function rootIdentity(value: string): { normalizedUrl: string; origin: string } {
  const url = new URL(value);
  url.hash = "";
  return { normalizedUrl: url.href, origin: url.origin };
}

function json(value: unknown, name: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${name} must be JSON serializable`);
  return encoded;
}

export class FrontierStore {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly now: () => number = () => Date.now()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    migrateFrontierSchema(this.database, this.now);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  createJob(input: CreateFrontierJobInput): FrontierJob {
    requirePositiveInteger(input.maxPages, "maxPages");
    const id = input.id ?? randomUUID();
    if (id.trim().length === 0) throw new Error("id must be a non-empty string");
    const { normalizedUrl, origin } = rootIdentity(input.rootUrl);
    const now = this.now();
    const originalInput = input.input ?? { url: input.rootUrl, maxPages: input.maxPages };
    const resources = initialCrawlResources({
      ...(input.crawlBudget === undefined ? {} : { crawlBudget: input.crawlBudget }),
      ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
      originalInput,
      maxPages: input.maxPages,
      now,
    });

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO crawl_jobs(
          id, status, input_json, created_at_ms, max_pages, concurrency, deadline_at_ms,
          budget_json, usage_json, reserved_usage_json, discovered_count, queued_count
        ) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
      `).run(
        id, json(originalInput, "input"), now, input.maxPages, resources.concurrency,
        resources.deadlineAtMs, JSON.stringify(resources.budget), JSON.stringify(resources.usage),
        JSON.stringify(resources.reserved),
      );
      this.database.prepare(`
        INSERT INTO crawl_frontier(
          id, crawl_id, requested_url, normalized_url, origin, depth,
          discovery_sequence, state, next_eligible_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, 0, 1, 'queued', ?, ?)
      `).run(randomUUID(), id, input.rootUrl, normalizedUrl, origin, now, now);
      this.database.exec("COMMIT");
      return this.requireJob(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getJob(id: string): FrontierJob | null {
    const row = this.database.prepare("SELECT * FROM crawl_jobs WHERE id = ?").get(id) as
      | JobRow
      | undefined;
    return row === undefined ? null : jobFromRow(row);
  }

  enqueue(input: EnqueueFrontierInput): EnqueueResult {
    if (input.crawlId.trim().length === 0) throw new Error("crawlId must be a non-empty string");
    if (input.normalizedUrl.trim().length === 0) {
      throw new Error("normalizedUrl must be a non-empty string");
    }
    if (!Number.isSafeInteger(input.depth) || input.depth < 0) {
      throw new Error("depth must be a non-negative integer");
    }
    const nextEligibleAtMs = input.nextEligibleAtMs ?? this.now();
    if (!Number.isSafeInteger(nextEligibleAtMs) || nextEligibleAtMs < 0) {
      throw new Error("nextEligibleAtMs must be a non-negative integer");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.database.prepare(
        "SELECT * FROM crawl_frontier WHERE crawl_id = ? AND normalized_url = ?",
      ).get(input.crawlId, input.normalizedUrl) as PageRow | undefined;
      if (duplicate !== undefined) {
        this.database.exec("COMMIT");
        return { inserted: false, reason: "duplicate", page: pageFromRow(duplicate) };
      }
      const job = this.database.prepare(
        "SELECT discovered_count, max_pages FROM crawl_jobs WHERE id = ?",
      ).get(input.crawlId) as { discovered_count: number; max_pages: number } | undefined;
      if (job === undefined) throw new Error(`crawl job not found: ${input.crawlId}`);
      if (job.discovered_count >= job.max_pages) {
        this.database.prepare("UPDATE crawl_jobs SET truncated = 1 WHERE id = ?").run(input.crawlId);
        this.database.exec("COMMIT");
        return { inserted: false, reason: "cap-reached", page: null };
      }
      const sequence = job.discovered_count + 1;
      const id = randomUUID();
      const createdAtMs = this.now();
      this.database.prepare(`
        INSERT INTO crawl_frontier(
          id, crawl_id, requested_url, normalized_url, origin, depth, discovered_from,
          discovery_sequence, state, next_eligible_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(
        id, input.crawlId, input.requestedUrl, input.normalizedUrl, input.origin,
        input.depth, input.discoveredFrom ?? null, sequence, nextEligibleAtMs, createdAtMs,
      );
      this.database.prepare(`
        UPDATE crawl_jobs
        SET discovered_count = discovered_count + 1, queued_count = queued_count + 1
        WHERE id = ?
      `).run(input.crawlId);
      const page = this.database.prepare("SELECT * FROM crawl_frontier WHERE id = ?").get(id) as PageRow;
      this.database.exec("COMMIT");
      return { inserted: true, reason: "enqueued", page: pageFromRow(page) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getProgress(id: string): FrontierProgress {
    return this.requireJob(id).progress;
  }

  deferOrigin(crawlId: string, origin: string, untilMs: number): void {
    this.requireJob(crawlId);
    persistOriginBackoff(this.database, crawlId, origin, untilMs);
  }

  markOriginStarted(lease: FrontierLease, intervalMs: number): boolean {
    return persistLeasedOriginStart(this.database, lease, intervalMs, this.now());
  }

  claimNext(input: ClaimFrontierInput): FrontierLease | null {
    if (input.owner.trim().length === 0) throw new Error("owner must be a non-empty string");
    requirePositiveInteger(input.leaseMs, "leaseMs");
    const originIntervalMs = input.originIntervalMs ?? 0;
    if (!Number.isSafeInteger(originIntervalMs) || originIntervalMs < 0) {
      throw new Error("originIntervalMs must be a non-negative integer");
    }
    const now = this.now();
    const expiresAtMs = now + input.leaseMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new Error("lease expiry exceeds safe integer range");

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.database.prepare(`
        SELECT frontier.id, frontier.origin
        FROM crawl_frontier AS frontier
        JOIN crawl_jobs AS job ON job.id = frontier.crawl_id
        LEFT JOIN crawl_origin_state AS origin
          ON origin.crawl_id = frontier.crawl_id AND origin.origin = frontier.origin
        WHERE frontier.crawl_id = ?
          AND frontier.state = 'queued'
          AND MAX(frontier.next_eligible_at_ms, COALESCE(origin.next_allowed_at_ms, 0),
                  COALESCE(origin.backoff_until_ms, 0)) <= ?
          AND job.status IN ('queued', 'running')
          AND job.pause_requested = 0
          AND job.cancel_requested = 0
        ORDER BY MAX(frontier.next_eligible_at_ms, COALESCE(origin.next_allowed_at_ms, 0),
                     COALESCE(origin.backoff_until_ms, 0)), frontier.discovery_sequence
        LIMIT 1
      `).get(input.crawlId, now) as { id: string; origin: string } | undefined;
      if (candidate === undefined) {
        this.database.exec("COMMIT");
        return null;
      }
      const job = this.database.prepare("SELECT * FROM crawl_jobs WHERE id = ?")
        .get(input.crawlId) as JobRow;
      const resources = parseResources(job);
      let reservation;
      try {
        reservation = reservePersistedResources(
          job,
          requestedPageBudget(input.requestedBudget, JSON.parse(job.input_json), resources.budget),
          now,
        );
      } catch (error) {
        if (!isBudgetExhausted(error)) throw error;
        stopQueuedForError(this.database, input.crawlId, error.toJSON(), now);
        this.database.exec("COMMIT");
        return null;
      }
      const nextAllowedAtMs = now + originIntervalMs;
      if (!Number.isSafeInteger(nextAllowedAtMs)) throw new Error("origin slot exceeds safe integer range");
      this.database.prepare(`
        INSERT INTO crawl_origin_state(crawl_id, origin, next_allowed_at_ms, version)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(crawl_id, origin) DO UPDATE SET
          next_allowed_at_ms = excluded.next_allowed_at_ms,
          version = crawl_origin_state.version + 1
      `).run(input.crawlId, candidate.origin, nextAllowedAtMs);
      const changed = this.database.prepare(`
        UPDATE crawl_frontier
        SET state = 'leased', lease_owner = ?, lease_expires_at_ms = ?,
            lease_generation = lease_generation + 1,
            execution_count = execution_count + 1, started_at_ms = ?, reserved_usage_json = ?
        WHERE id = ? AND state = 'queued'
      `).run(
        input.owner, expiresAtMs, now, JSON.stringify(reservation.reservation), candidate.id,
      ).changes;
      if (changed !== 1) throw new Error("frontier claim lost inside an immediate transaction");
      this.database.prepare(`
        UPDATE crawl_jobs
        SET status = 'running', started_at_ms = COALESCE(started_at_ms, ?),
            queued_count = queued_count - 1, leased_count = leased_count + 1,
            worker_owner = ?, reserved_usage_json = ?
        WHERE id = ?
      `).run(now, input.owner, JSON.stringify(reservation.reserved), input.crawlId);
      const row = this.database.prepare("SELECT * FROM crawl_frontier WHERE id = ?").get(candidate.id) as
        PageRow & { lease_generation: number };
      this.database.exec("COMMIT");
      return {
        page: pageFromRow(row),
        owner: input.owner,
        generation: row.lease_generation,
        expiresAtMs,
        budgetSlice: reservation.budgetSlice,
        reservation: reservation.reservation,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(lease: FrontierLease, leaseMs: number): boolean {
    requirePositiveInteger(leaseMs, "leaseMs");
    const now = this.now();
    const expiresAtMs = now + leaseMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new Error("lease expiry exceeds safe integer range");
    return this.database.prepare(`
      UPDATE crawl_frontier
      SET lease_expires_at_ms = ?
      WHERE id = ? AND crawl_id = ? AND state = 'leased'
        AND lease_owner = ? AND lease_generation = ?
    `).run(
      expiresAtMs, lease.page.id, lease.page.crawlId, lease.owner, lease.generation,
    ).changes === 1;
  }

  recoverExpiredLeases(crawlId?: string, excludedOwner?: string): number {
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const condition = [
        ...(crawlId === undefined ? [] : ["crawl_id = ?"]),
        "state = 'leased'",
        "lease_expires_at_ms <= ?",
        ...(excludedOwner === undefined ? [] : ["lease_owner <> ?"]),
      ].join(" AND ");
      const parameters = [
        ...(crawlId === undefined ? [] : [crawlId]),
        now,
        ...(excludedOwner === undefined ? [] : [excludedOwner]),
      ];
      const rows = this.database.prepare(`SELECT * FROM crawl_frontier WHERE ${condition}`)
        .all(...parameters) as unknown as PageRow[];
      for (const row of rows) {
        const job = this.database.prepare("SELECT * FROM crawl_jobs WHERE id = ?")
          .get(row.crawl_id) as JobRow;
        this.releasePageInTransaction(row, job, now);
      }
      this.database.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  commitSuccess(
    lease: FrontierLease,
    result: unknown,
    discovered: EnqueueCandidate[] = [],
    actual: CrawlResourceUsage = emptyCrawlResourceUsage(),
  ): boolean {
    return this.commitTerminal(lease, "succeeded", json(result, "result"), null, discovered, actual);
  }

  commitFailure(
    lease: FrontierLease,
    error: unknown,
    actual: CrawlResourceUsage = emptyCrawlResourceUsage(),
  ): boolean {
    return this.commitTerminal(lease, "failed", null, json(error, "error"), [], actual);
  }

  commitStopped(
    lease: FrontierLease,
    error: unknown,
    actual: CrawlResourceUsage = emptyCrawlResourceUsage(),
  ): boolean {
    return this.commitTerminal(lease, "stopped", null, json(error, "error"), [], actual);
  }

  private commitTerminal(
    lease: FrontierLease,
    state: "succeeded" | "failed" | "stopped",
    resultJson: string | null,
    errorJson: string | null,
    discovered: EnqueueCandidate[] = [],
    actual: CrawlResourceUsage = emptyCrawlResourceUsage(),
  ): boolean {
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const page = this.database.prepare(`
        SELECT * FROM crawl_frontier WHERE id = ? AND crawl_id = ? AND state = 'leased'
          AND lease_owner = ? AND lease_generation = ?
      `).get(
        lease.page.id, lease.page.crawlId, lease.owner, lease.generation,
      ) as PageRow | undefined;
      if (page === undefined) {
        this.database.exec("COMMIT");
        return false;
      }
      const job = this.database.prepare("SELECT * FROM crawl_jobs WHERE id = ?")
        .get(lease.page.crawlId) as JobRow;
      const settled = settlePersistedResources(
        job, JSON.parse(page.reserved_usage_json) as CrawlResourceUsage, actual,
      );
      const changed = this.database.prepare(`
        UPDATE crawl_frontier
        SET state = ?, result_json = ?, error_json = ?,
            publication_sequence = (
              SELECT next_publication_sequence FROM crawl_jobs WHERE id = crawl_frontier.crawl_id
            ),
            lease_owner = NULL, lease_expires_at_ms = NULL, completed_at_ms = ?,
            reserved_usage_json = ?
        WHERE id = ? AND crawl_id = ? AND state = 'leased'
          AND lease_owner = ? AND lease_generation = ?
      `).run(
        state, resultJson, errorJson, now, emptyUsageJson, lease.page.id, lease.page.crawlId,
        lease.owner, lease.generation,
      ).changes;
      if (changed === 0) {
        this.database.exec("COMMIT");
        return false;
      }
      const counter = state === "succeeded"
        ? "succeeded_count"
        : state === "failed" ? "failed_count" : "stopped_count";
      this.database.prepare(`
        UPDATE crawl_jobs
        SET leased_count = leased_count - 1,
            ${counter} = ${counter} + 1,
            published_count = published_count + 1,
            next_publication_sequence = next_publication_sequence + 1,
            usage_json = ?, reserved_usage_json = ?
        WHERE id = ?
      `).run(JSON.stringify(settled.usage), JSON.stringify(settled.reserved), lease.page.crawlId);
      for (const candidate of discovered) {
        this.enqueueDiscoveredInTransaction(lease, candidate, now);
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private enqueueDiscoveredInTransaction(
    lease: FrontierLease,
    candidate: EnqueueCandidate,
    now: number,
  ): void {
    if (candidate.normalizedUrl.trim().length === 0) {
      throw new Error("normalizedUrl must be a non-empty string");
    }
    if (!Number.isSafeInteger(candidate.depth) || candidate.depth < 0) {
      throw new Error("depth must be a non-negative integer");
    }
    const duplicate = this.database.prepare(`
      SELECT 1 FROM crawl_frontier WHERE crawl_id = ? AND normalized_url = ?
    `).get(lease.page.crawlId, candidate.normalizedUrl);
    if (duplicate !== undefined) return;
    const job = this.database.prepare(`
      SELECT discovered_count, max_pages FROM crawl_jobs WHERE id = ?
    `).get(lease.page.crawlId) as { discovered_count: number; max_pages: number };
    if (job.discovered_count >= job.max_pages) {
      this.database.prepare("UPDATE crawl_jobs SET truncated = 1 WHERE id = ?")
        .run(lease.page.crawlId);
      return;
    }
    const nextEligibleAtMs = candidate.nextEligibleAtMs ?? now;
    if (!Number.isSafeInteger(nextEligibleAtMs) || nextEligibleAtMs < 0) {
      throw new Error("nextEligibleAtMs must be a non-negative integer");
    }
    this.database.prepare(`
      INSERT INTO crawl_frontier(
        id, crawl_id, requested_url, normalized_url, origin, depth, discovered_from,
        discovery_sequence, state, next_eligible_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      randomUUID(), lease.page.crawlId, candidate.requestedUrl, candidate.normalizedUrl,
      candidate.origin, candidate.depth, candidate.discoveredFrom ?? lease.page.id,
      job.discovered_count + 1, nextEligibleAtMs, now,
    );
    this.database.prepare(`
      UPDATE crawl_jobs
      SET discovered_count = discovered_count + 1, queued_count = queued_count + 1
      WHERE id = ?
    `).run(lease.page.crawlId);
  }

  listPublications(crawlId: string, afterSequence: number, limit: number): FrontierPublicationBatch {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("afterSequence must be a non-negative integer");
    }
    requirePositiveInteger(limit, "limit");
    if (limit > 1_000) throw new Error("limit cannot exceed 1000");
    const rows = this.database.prepare(`
      SELECT * FROM crawl_frontier
      WHERE crawl_id = ? AND publication_sequence > ?
      ORDER BY publication_sequence
      LIMIT ?
    `).all(crawlId, afterSequence, limit) as unknown as Array<PageRow & {
      publication_sequence: number;
      result_json: string | null;
      error_json: string | null;
    }>;
    const job = this.requireJob(crawlId);
    return {
      crawlId,
      pages: rows.map((row) => ({
        sequence: row.publication_sequence,
        page: pageFromRow(row),
        result: row.result_json === null ? null : JSON.parse(row.result_json) as unknown,
        error: row.error_json === null ? null : JSON.parse(row.error_json) as unknown,
      })),
      nextSequence: rows.at(-1)?.publication_sequence ?? afterSequence,
      done: job.progress.queued === 0 && job.progress.leased === 0 &&
        (rows.at(-1)?.publication_sequence ?? afterSequence) >= job.progress.published,
    };
  }

  listRunnableJobs(): FrontierJob[] {
    const rows = this.database.prepare(`
      SELECT * FROM crawl_jobs
      WHERE status IN ('queued', 'running') AND pause_requested = 0 AND cancel_requested = 0
      ORDER BY created_at_ms, id
    `).all() as unknown as JobRow[];
    return rows.map(jobFromRow);
  }

  setJobStatus(id: string, status: FrontierJob["status"]): FrontierJob {
    const current = this.requireJob(id);
    if (!canTransitionFrontierJob(current.status, status)) {
      throw new Error(`cannot transition crawl job ${id} from ${current.status} to ${status}`);
    }
    if (current.status === status) return current;
    const now = this.now();
    if (status === "running") {
      this.database.prepare(`
        UPDATE crawl_jobs SET status = 'running', pause_requested = 0,
          started_at_ms = COALESCE(started_at_ms, ?), completed_at_ms = NULL
        WHERE id = ?
      `).run(now, id);
    } else if (status === "paused") {
      this.database.prepare(
        "UPDATE crawl_jobs SET status = 'paused', pause_requested = 1 WHERE id = ?",
      ).run(id);
    } else if (status === "cancelled") {
      const cancellation = JSON.stringify({
        status: "error",
        code: "CRAWL_CANCELLED",
        message: "The crawl job was cancelled before this page was claimed.",
        retryable: false,
        details: {},
        execution: null,
      });
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const queued = this.database.prepare(`
          SELECT id FROM crawl_frontier
          WHERE crawl_id = ? AND state = 'queued'
          ORDER BY discovery_sequence
        `).all(id) as unknown as Array<{ id: string }>;
        const sequence = this.database.prepare(`
          SELECT next_publication_sequence AS value FROM crawl_jobs WHERE id = ?
        `).get(id) as { value: number };
        const stopPage = this.database.prepare(`
          UPDATE crawl_frontier
          SET state = 'stopped', error_json = ?, publication_sequence = ?, completed_at_ms = ?
          WHERE id = ? AND state = 'queued'
        `);
        let stopped = 0;
        for (const [index, page] of queued.entries()) {
          stopped += Number(stopPage.run(cancellation, sequence.value + index, now, page.id).changes);
        }
        this.database.prepare(`
          UPDATE crawl_jobs
          SET status = 'cancelled', cancel_requested = 1, completed_at_ms = ?,
              queued_count = queued_count - ?, stopped_count = stopped_count + ?,
              published_count = published_count + ?,
              next_publication_sequence = next_publication_sequence + ?
          WHERE id = ?
        `).run(now, stopped, stopped, stopped, stopped, id);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    } else {
      this.database.prepare(
        "UPDATE crawl_jobs SET status = ?, completed_at_ms = ? WHERE id = ?",
      ).run(status, now, id);
    }
    return this.requireJob(id);
  }

  requestPause(id: string): FrontierJob {
    return this.setJobStatus(id, "paused");
  }

  resume(id: string): FrontierJob {
    return this.setJobStatus(id, "running");
  }

  requestCancel(id: string): FrontierJob {
    return this.setJobStatus(id, "cancelled");
  }

  isPauseRequested(id: string): boolean {
    return this.requireJob(id).pauseRequested;
  }

  isCancelRequested(id: string): boolean {
    return this.requireJob(id).cancelRequested;
  }

  releaseLease(lease: FrontierLease): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const page = this.database.prepare(`
        SELECT * FROM crawl_frontier WHERE id = ? AND crawl_id = ? AND state = 'leased'
          AND lease_owner = ? AND lease_generation = ?
      `).get(
        lease.page.id, lease.page.crawlId, lease.owner, lease.generation,
      ) as PageRow | undefined;
      if (page === undefined) {
        this.database.exec("COMMIT");
        return false;
      }
      const job = this.database.prepare("SELECT * FROM crawl_jobs WHERE id = ?")
        .get(lease.page.crawlId) as JobRow;
      this.releasePageInTransaction(page, job, this.now());
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private releasePageInTransaction(page: PageRow, job: JobRow, now: number): void {
    const settled = settlePersistedResources(
      job, JSON.parse(page.reserved_usage_json) as CrawlResourceUsage,
    );
    const terminal = job.status === "failed" || job.status === "cancelled" || job.status === "completed";
    if (terminal) {
      const error = job.error_json ?? JSON.stringify({
        code: "CRAWL_STOPPED", message: "The crawl ended before the leased page completed.",
      });
      this.database.prepare(`
        UPDATE crawl_frontier SET state = 'stopped', lease_owner = NULL,
          lease_expires_at_ms = NULL, completed_at_ms = ?, reserved_usage_json = ?,
          error_json = ?, publication_sequence = ? WHERE id = ?
      `).run(now, emptyUsageJson, error, job.next_publication_sequence, page.id);
      this.database.prepare(`
        UPDATE crawl_jobs SET leased_count = leased_count - 1, stopped_count = stopped_count + 1,
          published_count = published_count + 1, next_publication_sequence = next_publication_sequence + 1,
          usage_json = ?, reserved_usage_json = ? WHERE id = ?
      `).run(JSON.stringify(settled.usage), JSON.stringify(settled.reserved), page.crawl_id);
    } else {
      this.database.prepare(`
        UPDATE crawl_frontier SET state = 'queued', lease_owner = NULL,
          lease_expires_at_ms = NULL, started_at_ms = NULL, reserved_usage_json = ? WHERE id = ?
      `).run(emptyUsageJson, page.id);
      this.database.prepare(`
        UPDATE crawl_jobs SET queued_count = queued_count + 1, leased_count = leased_count - 1,
          usage_json = ?, reserved_usage_json = ? WHERE id = ?
      `).run(JSON.stringify(settled.usage), JSON.stringify(settled.reserved), page.crawl_id);
    }
  }

  nextWakeAt(crawlId?: string, excludedOwner?: string): number | null {
    const queued = crawlId === undefined
      ? this.database.prepare(`
          SELECT MIN(MAX(frontier.next_eligible_at_ms, COALESCE(origin.next_allowed_at_ms, 0),
                         COALESCE(origin.backoff_until_ms, 0))) AS wake_at
          FROM crawl_frontier AS frontier
          JOIN crawl_jobs AS job ON job.id = frontier.crawl_id
          LEFT JOIN crawl_origin_state AS origin
            ON origin.crawl_id = frontier.crawl_id AND origin.origin = frontier.origin
          WHERE frontier.state = 'queued' AND job.status IN ('queued','running')
            AND job.pause_requested = 0 AND job.cancel_requested = 0
        `).get() as { wake_at: number | null }
      : this.database.prepare(`
          SELECT MIN(MAX(frontier.next_eligible_at_ms, COALESCE(origin.next_allowed_at_ms, 0),
                         COALESCE(origin.backoff_until_ms, 0))) AS wake_at
          FROM crawl_frontier AS frontier
          JOIN crawl_jobs AS job ON job.id = frontier.crawl_id
          LEFT JOIN crawl_origin_state AS origin
            ON origin.crawl_id = frontier.crawl_id AND origin.origin = frontier.origin
          WHERE frontier.crawl_id = ? AND frontier.state = 'queued'
            AND job.status IN ('queued','running')
            AND job.pause_requested = 0 AND job.cancel_requested = 0
        `).get(crawlId) as { wake_at: number | null };
    const leased = crawlId === undefined
      ? this.database.prepare(`
          SELECT MIN(lease_expires_at_ms) AS wake_at FROM crawl_frontier
          WHERE state = 'leased' AND (? IS NULL OR lease_owner <> ?)
        `).get(excludedOwner ?? null, excludedOwner ?? null) as { wake_at: number | null }
      : this.database.prepare(`
          SELECT MIN(lease_expires_at_ms) AS wake_at
          FROM crawl_frontier WHERE crawl_id = ? AND state = 'leased'
            AND (? IS NULL OR lease_owner <> ?)
        `).get(crawlId, excludedOwner ?? null, excludedOwner ?? null) as { wake_at: number | null };
    if (queued.wake_at === null) return leased.wake_at;
    if (leased.wake_at === null) return queued.wake_at;
    return Math.min(queued.wake_at, leased.wake_at);
  }

  private requireJob(id: string): FrontierJob {
    const job = this.getJob(id);
    if (job === null) throw new Error(`crawl job not found: ${id}`);
    return job;
  }

  close(): void {
    this.database.close();
  }
}
