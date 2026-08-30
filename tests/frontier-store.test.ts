import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { FrontierStore } from "../src/frontier-store.js";
import { emptyCrawlResourceUsage } from "../src/runtime/resource-governor.js";
import type { CrawlBudget, CrawlResourceUsage, ExecutionBudget } from "../src/types.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "frontier-store-"));
  directories.push(directory);
  return join(directory, "crawl.sqlite");
}

const persistedBudget: CrawlBudget = {
  maxDurationMs: 10_000,
  maxProviderAttempts: 2,
  maxDocumentBytes: 10_000,
  maxBrowserMs: 0,
  maxBrowserContexts: 0,
};

const requestedBudget: ExecutionBudget = {
  deadlineMs: 5_000,
  maxAttempts: 1,
  maxDocumentBytes: 4_000,
  maxBrowserMs: 0,
  maxBrowserContexts: 0,
  maxOptionalModelTokens: 0,
};

function usage(overrides: Partial<CrawlResourceUsage> = {}): CrawlResourceUsage {
  return { ...emptyCrawlResourceUsage(), ...overrides };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FrontierStore", () => {
  it("rejects the removed legacy job schema without rewriting its data", () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE crawl_jobs (
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
      INSERT INTO crawl_jobs(id, status, input_json, created_at_ms)
      VALUES ('legacy-running', 'running', '{"url":"https://legacy.test/"}', 1);
    `);
    legacy.close();

    expect(() => new FrontierStore(path, () => 999)).toThrow(
      "Legacy crawl_jobs schema is unsupported",
    );

    const unchanged = new DatabaseSync(path);
    const row = unchanged.prepare(
      "SELECT status, completed_at_ms FROM crawl_jobs WHERE id = ?",
    ).get("legacy-running") as {
      status: string;
      completed_at_ms: number | null;
    };
    expect(row).toEqual({ status: "running", completed_at_ms: null });
    unchanged.close();
  });

  it("migrates a real SQLite file and creates a job with its root queued", () => {
    const path = databasePath();
    const store = new FrontierStore(path, () => 1_000);

    const job = store.createJob({
      id: "crawl-1",
      rootUrl: "https://example.test/root#fragment",
      maxPages: 3,
      input: { url: "https://example.test/root#fragment", maxPages: 3 },
    });

    expect(job).toMatchObject({
      id: "crawl-1",
      status: "queued",
      maxPages: 3,
      input: { url: "https://example.test/root#fragment", maxPages: 3 },
      progress: {
        discovered: 1,
        queued: 1,
        leased: 0,
        succeeded: 0,
        failed: 0,
        stopped: 0,
        published: 0,
      },
    });

    store.close();

    const database = new DatabaseSync(path);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("SELECT normalized_url, state, depth FROM crawl_frontier").get())
      .toEqual({ normalized_url: "https://example.test/root", state: "queued", depth: 0 });
    expect(database.prepare("SELECT MAX(version) AS version FROM frontier_schema_migrations").get())
      .toEqual({ version: 3 });
    database.close();
  });

  it("migrates v2 empty resource JSON before an active crawl is resumed", () => {
    const path = databasePath();
    const initial = new FrontierStore(path, () => 1_000);
    initial.createJob({
      id: "crawl-v2-resources",
      rootUrl: "https://example.test/",
      maxPages: 2,
      input: {
        url: "https://example.test/",
        concurrency: 2,
        crawlBudget: persistedBudget,
        budget: requestedBudget,
      },
    });
    initial.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DELETE FROM frontier_schema_migrations WHERE version = 3;
      UPDATE crawl_jobs SET budget_json = '{}', usage_json = '{}', reserved_usage_json = '{}',
        deadline_at_ms = NULL, concurrency = 1;
      UPDATE crawl_frontier SET reserved_usage_json = '{}';
    `);
    legacy.close();

    const migrated = new FrontierStore(path, () => 5_000);
    expect(migrated.getJob("crawl-v2-resources")).toMatchObject({
      budget: persistedBudget,
      concurrency: 2,
      deadlineAtMs: 11_000,
      usage: usage(),
      reservedUsage: usage(),
    });
    migrated.close();
  });

  it("atomically deduplicates discovered URLs and enforces the page cap", () => {
    const path = databasePath();
    const store = new FrontierStore(path, () => 2_000);
    store.createJob({ id: "crawl-cap", rootUrl: "https://example.test/", maxPages: 3 });

    const first = store.enqueue({
      crawlId: "crawl-cap",
      requestedUrl: "https://example.test/a#one",
      normalizedUrl: "https://example.test/a",
      origin: "https://example.test",
      depth: 1,
      discoveredFrom: "root",
    });
    const duplicate = store.enqueue({
      crawlId: "crawl-cap",
      requestedUrl: "https://example.test/a#two",
      normalizedUrl: "https://example.test/a",
      origin: "https://example.test",
      depth: 2,
    });
    const second = store.enqueue({
      crawlId: "crawl-cap",
      requestedUrl: "https://example.test/b",
      normalizedUrl: "https://example.test/b",
      origin: "https://example.test",
      depth: 1,
    });
    const capped = store.enqueue({
      crawlId: "crawl-cap",
      requestedUrl: "https://example.test/c",
      normalizedUrl: "https://example.test/c",
      origin: "https://example.test",
      depth: 1,
    });

    expect(first).toMatchObject({ inserted: true, reason: "enqueued" });
    expect(duplicate).toMatchObject({
      inserted: false,
      reason: "duplicate",
      page: { id: first.page?.id, discoverySequence: 2 },
    });
    expect(second).toMatchObject({ inserted: true, page: { discoverySequence: 3 } });
    expect(capped).toEqual({ inserted: false, reason: "cap-reached", page: null });
    expect(store.getProgress("crawl-cap")).toEqual({
      discovered: 3,
      queued: 3,
      leased: 0,
      succeeded: 0,
      failed: 0,
      stopped: 0,
      published: 0,
    });
    expect(store.getJob("crawl-cap")?.truncated).toBe(true);
    store.close();

    const reopened = new FrontierStore(path, () => 3_000);
    expect(reopened.getProgress("crawl-cap").discovered).toBe(3);
    reopened.close();
  });

  it("claims a page once and fences a stale owner after lease recovery", () => {
    const path = databasePath();
    let now = 10_000;
    const first = new FrontierStore(path, () => now);
    first.createJob({ id: "crawl-lease", rootUrl: "https://example.test/", maxPages: 2 });
    const second = new FrontierStore(path, () => now);

    const oldLease = first.claimNext({ crawlId: "crawl-lease", owner: "worker-a", leaseMs: 500 });
    expect(oldLease).toMatchObject({ owner: "worker-a", generation: 1, expiresAtMs: 10_500 });
    expect(second.claimNext({ crawlId: "crawl-lease", owner: "worker-b", leaseMs: 500 })).toBeNull();
    expect(first.heartbeat(oldLease!, 700)).toBe(true);
    expect(first.getProgress("crawl-lease")).toMatchObject({ queued: 0, leased: 1 });

    now = 10_701;
    expect(second.recoverExpiredLeases("crawl-lease")).toBe(1);
    expect(first.getProgress("crawl-lease")).toMatchObject({ queued: 1, leased: 0 });
    const newLease = second.claimNext({ crawlId: "crawl-lease", owner: "worker-b", leaseMs: 500 });
    expect(newLease).toMatchObject({ owner: "worker-b", generation: 2, expiresAtMs: 11_201 });

    expect(first.heartbeat(oldLease!, 500)).toBe(false);
    expect(first.commitSuccess(oldLease!, { title: "stale" })).toBe(false);
    expect(second.commitFailure(newLease!, { code: "HTTP_500" })).toBe(true);
    expect(second.getProgress("crawl-lease")).toMatchObject({ leased: 0, failed: 1, published: 1 });

    first.close();
    second.close();
  });

  it("allows the current generation to renew after timer jitter until recovery wins", () => {
    const path = databasePath();
    let now = 15_000;
    const store = new FrontierStore(path, () => now);
    store.createJob({ id: "crawl-heartbeat-jitter", rootUrl: "https://example.test/", maxPages: 1 });
    const lease = store.claimNext({
      crawlId: "crawl-heartbeat-jitter", owner: "worker", leaseMs: 100,
    });

    now = 15_101;
    expect(store.heartbeat(lease!, 500)).toBe(true);
    expect(store.recoverExpiredLeases("crawl-heartbeat-jitter")).toBe(0);
    expect(store.commitSuccess(lease!, { title: "completed" })).toBe(true);
    expect(store.getProgress("crawl-heartbeat-jitter")).toMatchObject({ succeeded: 1, leased: 0 });
    store.close();
  });

  it("commits success, discovered links, and publication atomically across reopen", () => {
    const path = databasePath();
    let now = 20_000;
    const store = new FrontierStore(path, () => now);
    store.createJob({ id: "crawl-publish", rootUrl: "https://example.test/", maxPages: 3 });
    const root = store.claimNext({ crawlId: "crawl-publish", owner: "worker", leaseMs: 1_000 });

    expect(store.commitSuccess(root!, { title: "root" }, [
      {
        requestedUrl: "https://example.test/a",
        normalizedUrl: "https://example.test/a",
        origin: "https://example.test",
        depth: 1,
      },
      {
        requestedUrl: "https://example.test/b",
        normalizedUrl: "https://example.test/b",
        origin: "https://example.test",
        depth: 1,
      },
      {
        requestedUrl: "https://example.test/a#duplicate",
        normalizedUrl: "https://example.test/a",
        origin: "https://example.test",
        depth: 2,
      },
    ])).toBe(true);
    store.close();

    const reopened = new FrontierStore(path, () => now);
    expect(reopened.getProgress("crawl-publish")).toEqual({
      discovered: 3,
      queued: 2,
      leased: 0,
      succeeded: 1,
      failed: 0,
      stopped: 0,
      published: 1,
    });
    expect(reopened.listPublications("crawl-publish", 0, 1)).toMatchObject({
      crawlId: "crawl-publish",
      pages: [{ sequence: 1, result: { title: "root" }, error: null }],
      nextSequence: 1,
      done: false,
    });

    now += 1;
    const firstChild = reopened.claimNext({ crawlId: "crawl-publish", owner: "worker", leaseMs: 1_000 });
    expect(reopened.commitSuccess(firstChild!, { title: "a" })).toBe(true);
    const secondChild = reopened.claimNext({ crawlId: "crawl-publish", owner: "worker", leaseMs: 1_000 });
    expect(reopened.commitStopped(secondChild!, { code: "BUDGET_EXHAUSTED" })).toBe(true);

    const batch = reopened.listPublications("crawl-publish", 1, 10);
    expect(batch.pages.map((page) => page.sequence)).toEqual([2, 3]);
    expect(batch.pages.map((page) => page.page.normalizedUrl)).toEqual([
      "https://example.test/a",
      "https://example.test/b",
    ]);
    expect(batch).toMatchObject({ nextSequence: 3, done: true });
    reopened.close();
  });

  it("persists job controls and exposes the next durable wake time", () => {
    const path = databasePath();
    let now = 30_000;
    const store = new FrontierStore(path, () => now);
    store.createJob({ id: "crawl-control", rootUrl: "https://example.test/", maxPages: 2 });

    expect(store.listRunnableJobs().map((job) => job.id)).toEqual(["crawl-control"]);
    expect(store.nextWakeAt("crawl-control")).toBe(30_000);
    expect(store.requestPause("crawl-control").status).toBe("paused");
    expect(store.isPauseRequested("crawl-control")).toBe(true);
    expect(store.listRunnableJobs()).toEqual([]);
    expect(store.claimNext({ crawlId: "crawl-control", owner: "worker", leaseMs: 500 })).toBeNull();

    expect(store.resume("crawl-control").status).toBe("running");
    expect(store.isPauseRequested("crawl-control")).toBe(false);
    const lease = store.claimNext({ crawlId: "crawl-control", owner: "worker", leaseMs: 500 });
    expect(store.nextWakeAt("crawl-control")).toBe(30_500);
    expect(store.releaseLease(lease!)).toBe(true);
    expect(store.nextWakeAt("crawl-control")).toBe(30_000);

    expect(store.requestCancel("crawl-control").status).toBe("cancelled");
    expect(store.isCancelRequested("crawl-control")).toBe(true);
    expect(store.listRunnableJobs()).toEqual([]);
    expect(() => store.resume("crawl-control")).toThrow(/cannot transition/);

    now += 1;
    store.createJob({ id: "crawl-state", rootUrl: "https://other.test/", maxPages: 1 });
    expect(store.setJobStatus("crawl-state", "running").status).toBe("running");
    expect(store.setJobStatus("crawl-state", "completed").status).toBe("completed");
    expect(() => store.setJobStatus("crawl-state", "running")).toThrow(/cannot transition/);
    store.close();
  });

  it("persists crawl budget, concurrency, deadline, usage, and reserved usage", () => {
    const path = databasePath();
    const store = new FrontierStore(path, () => 40_000);
    const job = store.createJob({
      id: "crawl-budget-metadata",
      rootUrl: "https://example.test/",
      maxPages: 3,
      concurrency: 3,
      crawlBudget: persistedBudget,
      input: {
        url: "https://example.test/",
        maxPages: 3,
        concurrency: 3,
        crawlBudget: persistedBudget,
        budget: requestedBudget,
      },
    });

    expect(job).toMatchObject({
      concurrency: 3,
      budget: persistedBudget,
      deadlineAtMs: 50_000,
      usage: usage(),
      reservedUsage: usage(),
      error: null,
    });
    store.close();

    const database = new DatabaseSync(path);
    const row = database.prepare(`
      SELECT concurrency, deadline_at_ms, budget_json, usage_json, reserved_usage_json
      FROM crawl_jobs WHERE id = ?
    `).get("crawl-budget-metadata") as Record<string, number | string>;
    expect(row).toMatchObject({ concurrency: 3, deadline_at_ms: 50_000 });
    expect(JSON.parse(String(row.budget_json))).toEqual(persistedBudget);
    expect(JSON.parse(String(row.usage_json))).toEqual(usage());
    expect(JSON.parse(String(row.reserved_usage_json))).toEqual(usage());
    database.close();
  });

  it("reserves and settles concurrent page budgets then converges exhaustion", () => {
    const path = databasePath();
    let now = 60_000;
    const store = new FrontierStore(path, () => now);
    store.createJob({
      id: "crawl-budget",
      rootUrl: "https://example.test/",
      maxPages: 3,
      concurrency: 3,
      crawlBudget: persistedBudget,
      input: { url: "https://example.test/", budget: requestedBudget },
    });

    const root = store.claimNext({
      crawlId: "crawl-budget",
      owner: "worker",
      leaseMs: 1_000,
      requestedBudget,
      originIntervalMs: 0,
    });
    expect(root).toMatchObject({
      budgetSlice: requestedBudget,
      reservation: usage({ providerAttempts: 1, documentBytesIn: 4_000 }),
    });
    expect(store.getJob("crawl-budget")?.reservedUsage).toEqual(
      usage({ providerAttempts: 1, documentBytesIn: 4_000 }),
    );
    expect(store.commitSuccess(root!, { title: "root" }, [
      {
        requestedUrl: "https://example.test/a",
        normalizedUrl: "https://example.test/a",
        origin: "https://example.test",
        depth: 1,
      },
      {
        requestedUrl: "https://example.test/b",
        normalizedUrl: "https://example.test/b",
        origin: "https://example.test",
        depth: 1,
      },
    ], usage({ providerAttempts: 1, documentBytesIn: 100 }))).toBe(true);

    const firstChild = store.claimNext({
      crawlId: "crawl-budget",
      owner: "worker",
      leaseMs: 1_000,
      requestedBudget,
      originIntervalMs: 0,
    });
    expect(firstChild?.budgetSlice.maxAttempts).toBe(1);
    expect(store.claimNext({
      crawlId: "crawl-budget",
      owner: "worker",
      leaseMs: 1_000,
      requestedBudget,
      originIntervalMs: 0,
    })).toBeNull();

    expect(store.getJob("crawl-budget")).toMatchObject({
      status: "failed",
      error: { code: "BUDGET_EXHAUSTED" },
      usage: usage({ providerAttempts: 1, documentBytesIn: 100 }),
      reservedUsage: usage({ providerAttempts: 1, documentBytesIn: 4_000 }),
      progress: { queued: 0, leased: 1, succeeded: 1, stopped: 1, published: 2 },
    });

    now += 1;
    expect(store.commitSuccess(
      firstChild!, { title: "a" }, [], usage({ providerAttempts: 1, documentBytesIn: 200 }),
    )).toBe(true);
    expect(store.getJob("crawl-budget")).toMatchObject({
      status: "failed",
      usage: usage({ providerAttempts: 2, documentBytesIn: 300 }),
      reservedUsage: usage(),
      progress: { queued: 0, leased: 0, succeeded: 2, stopped: 1, published: 3 },
    });
    const publications = store.listPublications("crawl-budget", 0, 10);
    expect(publications.done).toBe(true);
    expect(publications.pages.map((page) => page.page.state).sort()).toEqual([
      "stopped", "succeeded", "succeeded",
    ]);
    store.close();
  });

  it("recovers an expired lease on a budget-failed job directly to stopped", () => {
    const path = databasePath();
    let now = 70_000;
    const store = new FrontierStore(path, () => now);
    store.createJob({
      id: "crawl-budget-recovery",
      rootUrl: "https://example.test/",
      maxPages: 3,
      crawlBudget: persistedBudget,
      input: { url: "https://example.test/", budget: requestedBudget },
    });
    const root = store.claimNext({
      crawlId: "crawl-budget-recovery", owner: "worker", leaseMs: 500, requestedBudget,
    });
    store.commitSuccess(root!, { title: "root" }, [
      { requestedUrl: "https://example.test/a", normalizedUrl: "https://example.test/a",
        origin: "https://example.test", depth: 1 },
      { requestedUrl: "https://example.test/b", normalizedUrl: "https://example.test/b",
        origin: "https://example.test", depth: 1 },
    ], usage({ providerAttempts: 1 }));
    const active = store.claimNext({
      crawlId: "crawl-budget-recovery", owner: "worker", leaseMs: 500, requestedBudget,
    });
    expect(active).not.toBeNull();
    expect(store.claimNext({
      crawlId: "crawl-budget-recovery", owner: "worker", leaseMs: 500, requestedBudget,
    })).toBeNull();

    now = 70_501;
    expect(store.recoverExpiredLeases("crawl-budget-recovery")).toBe(1);
    expect(store.getJob("crawl-budget-recovery")).toMatchObject({
      status: "failed",
      reservedUsage: usage(),
      progress: { queued: 0, leased: 0, succeeded: 1, stopped: 2, published: 3 },
    });
    expect(store.listPublications("crawl-budget-recovery", 0, 10)).toMatchObject({ done: true });
    store.close();
  });

  it("persists origin start slots and releases reservations on release and expiry", () => {
    const path = databasePath();
    let now = 80_000;
    const store = new FrontierStore(path, () => now);
    store.createJob({
      id: "crawl-origin",
      rootUrl: "https://example.test/",
      maxPages: 2,
      crawlBudget: { ...persistedBudget, maxProviderAttempts: 5 },
      input: { url: "https://example.test/", budget: requestedBudget },
    });

    const root = store.claimNext({
      crawlId: "crawl-origin", owner: "worker", leaseMs: 500,
      requestedBudget, originIntervalMs: 100,
    });
    now = 80_020;
    expect(store.markOriginStarted(root!, 100)).toBe(true);
    expect(store.commitSuccess(root!, { title: "root" }, [{
      requestedUrl: "https://example.test/a",
      normalizedUrl: "https://example.test/a",
      origin: "https://example.test",
      depth: 1,
    }], usage({ providerAttempts: 1 }))).toBe(true);
    expect(store.nextWakeAt("crawl-origin")).toBe(80_120);
    now = 80_119;
    expect(store.claimNext({
      crawlId: "crawl-origin", owner: "worker", leaseMs: 500,
      requestedBudget, originIntervalMs: 100,
    })).toBeNull();

    now = 80_120;
    const released = store.claimNext({
      crawlId: "crawl-origin", owner: "worker", leaseMs: 500,
      requestedBudget, originIntervalMs: 100,
    });
    expect(store.releaseLease(released!)).toBe(true);
    expect(store.getJob("crawl-origin")?.reservedUsage).toEqual(usage());
    expect(store.nextWakeAt("crawl-origin")).toBe(80_220);

    now = 80_220;
    const expiring = store.claimNext({
      crawlId: "crawl-origin", owner: "worker", leaseMs: 500,
      requestedBudget, originIntervalMs: 100,
    });
    expect(expiring).not.toBeNull();
    now = 80_721;
    expect(store.recoverExpiredLeases("crawl-origin")).toBe(1);
    expect(store.getJob("crawl-origin")?.reservedUsage).toEqual(usage());
    expect(store.nextWakeAt("crawl-origin")).toBe(80_320);
    store.close();
  });

  it("returns persisted job lifecycle timestamps", () => {
    let now = 90_000;
    const store = new FrontierStore(databasePath(), () => now);
    store.createJob({
      id: "crawl-timestamps",
      rootUrl: "https://example.test/",
      maxPages: 1,
      crawlBudget: persistedBudget,
      input: { url: "https://example.test/", budget: requestedBudget },
    });
    expect(store.getJob("crawl-timestamps")).toMatchObject({
      createdAtMs: 90_000,
      startedAtMs: null,
      completedAtMs: null,
    });

    now = 90_100;
    const lease = store.claimNext({
      crawlId: "crawl-timestamps",
      owner: "worker",
      leaseMs: 500,
      requestedBudget,
    });
    expect(lease).not.toBeNull();
    expect(store.getJob("crawl-timestamps")?.startedAtMs).toBe(90_100);

    store.commitSuccess(lease!, { title: "root" }, [], usage({ providerAttempts: 1 }));
    now = 90_200;
    store.setJobStatus("crawl-timestamps", "completed");
    expect(store.getJob("crawl-timestamps")).toMatchObject({
      startedAtMs: 90_100,
      completedAtMs: 90_200,
    });
    store.close();
  });
});
