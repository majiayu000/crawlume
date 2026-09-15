import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
import { FrontierStore } from "../src/frontier-store.js";
import { AttemptLedger } from "../src/jobs.js";
import { CrawlerMetrics } from "../src/metrics.js";
import type { ReadPageResult } from "../src/types.js";

const stores: CrawlerMetrics[] = [];
const temporaryDirectories: string[] = [];

function result(overrides: Partial<ReadPageResult> = {}): ReadPageResult {
  return {
    status: "ok",
    sourceUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    fetchedAt: "2026-08-25T00:00:00.000Z",
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "Example",
    byline: null,
    publishedTime: null,
    contentMarkdown: "Article content",
    contentHash: "hash",
    completeness: "complete",
    validation: { outcome: "valid", validatorVersion: "generic-content-v1", checks: [], terminalError: null },
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 1_000,
      contentCharacters: 800,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      cacheStatus: "live",
      requestId: "request-test",
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{
          stageId: "http-read",
          provider: "http",
          reasonCode: "HTTP_PRIMARY",
        }],
        executedStages: ["http-read"],
      },
      attempts: 2,
      totalRetryDelayMs: 40,
      phaseDurationsMs: { extraction: 5, validation: 2 },
    },
    ...overrides,
  };
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("CrawlerMetrics", () => {
  it("aggregates live, cached, browser, and failed reads without charging cache network cost", () => {
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const metrics = new CrawlerMetrics(":memory:", () => now);
    stores.push(metrics);

    metrics.recordSuccess(result(), 100);
    metrics.recordSuccess(result({
      cached: true,
      evidence: { ...result().evidence, cacheStatus: "fresh" },
    }), 20);
    metrics.recordSuccess(result({ fetchMethod: "browser", evidence: {
      ...result().evidence,
      responseBytes: 2_000,
      contentCharacters: 1_500,
      attempts: 1,
      totalRetryDelayMs: 0,
    } }), 300);
    metrics.recordFailure(new ReadError("ACCESS_DENIED", "denied", {
      details: { attempts: 1, totalRetryDelayMs: 0 },
    }), 50, "policy_stop");

    expect(metrics.getStats(7)).toMatchObject({
      status: "ok",
      totals: {
        requests: 4,
        successes: 3,
        failures: 1,
        successRate: 0.75,
        cacheHits: 1,
        cacheHitRate: 1 / 3,
      },
      fetchMethods: { http: 1, browser: 1 },
      cost: {
        responseBytes: 3_000,
        contentCharacters: 3_100,
        attempts: 4,
        retryDelayMs: 40,
        durationMs: 470,
      },
      failureReasons: [{ code: "ACCESS_DENIED", count: 1 }],
    });
  });

  it("returns null rates for an empty window and excludes older and future buckets", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const metrics = new CrawlerMetrics(":memory:", () => now);
    stores.push(metrics);
    metrics.recordSuccess(result(), 10);
    now = Date.parse("2026-08-30T12:00:00.000Z");
    metrics.recordSuccess(result(), 10);
    now = Date.parse("2026-08-25T12:00:00.000Z");

    const stats = metrics.getStats(3);
    expect(stats.totals).toEqual({
      requests: 0,
      successes: 0,
      failures: 0,
      successRate: null,
      cacheHits: 0,
      cacheHitRate: null,
    });
    expect(stats.daily).toHaveLength(3);
    expect(stats.daily.map((day) => day.date)).toEqual([
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
    ]);
  });

  it("keeps aggregates across database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "crawlume-metrics-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "crawler.sqlite");
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const first = new CrawlerMetrics(path, () => now);
    first.recordSuccess(result(), 25);
    first.close();

    const reopened = new CrawlerMetrics(path, () => now);
    stores.push(reopened);
    expect(reopened.getStats(1).totals).toMatchObject({
      requests: 1,
      successes: 1,
      failures: 0,
    });
  });

  it("projects versioned runtime truth, stages, resources, transitions, cache, and crawl coverage", () => {
    const directory = mkdtempSync(join(tmpdir(), "crawlume-runtime-metrics-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "crawler.sqlite");
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const metrics = new CrawlerMetrics(path, () => now);
    stores.push(metrics);
    const ledger = new AttemptLedger(path, () => now);
    ledger.append({
      requestId: "request-sensitive-token",
      planId: `plan_${"a".repeat(64)}`,
      stageId: "http-read",
      provider: "http",
      providerVersion: "undici-http-provider-v1",
      outcome: "succeeded",
      rawRef: "raw:public",
      traceRef: null,
      errorCode: null,
      usage: {
        documentBytesIn: 1_000,
        networkBytesOut: 20,
        browserMilliseconds: 0,
        browserContextStarts: 0,
        retryDelayMilliseconds: 40,
        optionalModelTokens: 0,
      },
      startedAt: "2026-08-25T12:00:00.000Z",
      completedAt: "2026-08-25T12:00:00.100Z",
    });
    ledger.close();

    metrics.recordSuccess(result({
      sourceUrl: "https://secret.example/path?token=do-not-store",
      authProfile: "private-profile-do-not-store",
      title: "PRIVATE TITLE DO NOT STORE",
      contentMarkdown: "PRIVATE BODY DO NOT STORE",
    }), 125);
    metrics.recordFailure(new ReadError("ACCESS_DENIED", "secret failure detail", {
      execution: {
        requestId: "request-failure-secret",
        planId: `plan_${"b".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{
          stageId: "browser-read",
          provider: "browser",
          reasonCode: "BROWSER_REQUIRED_BY_AUTHORIZATION",
        }],
        executedStages: ["browser-read"],
      },
      traceRef: "browser-trace:secret",
    }), 25, "policy_stop");

    const frontier = new FrontierStore(path, () => now);
    frontier.createJob({
      id: "crawl-metrics",
      rootUrl: "https://crawl-secret.example/?token=do-not-store",
      maxPages: 3,
    });
    frontier.close();
    const database = new DatabaseSync(path);
    database.prepare(`
      UPDATE crawl_jobs SET status = 'completed', completed_at_ms = ?,
        discovered_count = 3, queued_count = 0, succeeded_count = 2,
        failed_count = 1, stopped_count = 0, published_count = 3
      WHERE id = 'crawl-metrics'
    `).run(now);
    database.close();

    expect(metrics.getStats(1)).toMatchObject({
      finalStates: {
        completed: 1,
        completed_uncertain: 0,
        invalid: 0,
        failed: 0,
        policy_stop: 1,
        budget_exhausted: 0,
        cancelled: 0,
      },
      cache: { live: 1, fresh: 0, revalidated: 0, stale: 0, replayed: 0 },
      versions: {
        planners: [{ version: "access-planner-v1", count: 2 }],
        providers: [{ provider: "http", version: "undici-http-provider-v1", count: 1 }],
        extractors: [{ version: "readability-v1", count: 1 }],
        validators: [{ version: "generic-content-v1", count: 1 }],
      },
      stages: [{
        stageId: "http-read",
        provider: "http",
        providerVersion: "undici-http-provider-v1",
        outcome: "succeeded",
        attempts: 1,
        durationMs: 100,
      }],
      resources: {
        documentBytesIn: 1_000,
        networkBytesOut: 20,
        browserMilliseconds: 0,
        browserContextStarts: 0,
        retryDelayMilliseconds: 40,
        optionalModelTokens: 0,
      },
      phaseDurationsMs: { provider: 100, extraction: 5, validation: 2, endToEnd: 150 },
      transitions: [
        {
          plannerVersion: "access-planner-v1",
          stageId: "browser-read",
          provider: "browser",
          reasonCode: "BROWSER_REQUIRED_BY_AUTHORIZATION",
          count: 1,
        },
        {
          plannerVersion: "access-planner-v1",
          stageId: "http-read",
          provider: "http",
          reasonCode: "HTTP_PRIMARY",
          count: 1,
        },
      ],
      crawlCoverage: {
        jobs: 1,
        discoveredPages: 3,
        publishedPages: 3,
        succeededPages: 2,
        failedPages: 1,
        stoppedPages: 0,
        coverageRate: 1,
      },
    });

    const persisted = new DatabaseSync(path);
    const metricRows = persisted.prepare("SELECT * FROM runtime_metrics_daily").all();
    const transitionRows = persisted.prepare("SELECT * FROM runtime_transition_metrics_daily").all();
    persisted.close();
    expect(JSON.stringify([metricRows, transitionRows])).not.toMatch(
      /secret|do-not-store|private-profile|private title|private body|browser-trace/iu,
    );
  });

  it.each([0, 91, 1.5])("rejects an invalid %s-day window", (days) => {
    const metrics = new CrawlerMetrics(":memory:");
    stores.push(metrics);
    expect(() => metrics.getStats(days)).toThrow("between 1 and 90");
  });
});
