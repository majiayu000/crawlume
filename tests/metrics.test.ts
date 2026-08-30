import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
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
    validation: { status: "usable", warnings: [] },
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 1_000,
      contentCharacters: 800,
      extractionMethod: "readability",
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
    metrics.recordSuccess(result({ cached: true }), 20);
    metrics.recordSuccess(result({ fetchMethod: "browser", evidence: {
      ...result().evidence,
      responseBytes: 2_000,
      contentCharacters: 1_500,
      attempts: 1,
      totalRetryDelayMs: 0,
    } }), 300);
    metrics.recordFailure(new ReadError("ACCESS_DENIED", "denied", {
      details: { attempts: 1, totalRetryDelayMs: 0 },
    }), 50);

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
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-metrics-test-"));
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

  it.each([0, 91, 1.5])("rejects an invalid %s-day window", (days) => {
    const metrics = new CrawlerMetrics(":memory:");
    stores.push(metrics);
    expect(() => metrics.getStats(days)).toThrow("between 1 and 90");
  });
});
