import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
import { SearchServingMetrics } from "../src/search-metrics.js";
import type { SearchServingResult } from "../src/types.js";

const stores: SearchServingMetrics[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function servingResult(
  status: "ok" | "partial",
  executedSources: Array<"local" | "web">,
): SearchServingResult {
  return {
    status,
    query: "PRIVATE QUERY do-not-store",
    provider: "https://provider.example/private",
    searchedAt: "2026-08-31T12:00:00.000Z",
    page: 1,
    results: [{
      title: "PRIVATE TITLE do-not-store",
      url: "https://secret.example/path?token=do-not-store",
      snippet: "PRIVATE BODY do-not-store",
      source: executedSources.includes("local") ? "local" : "web",
      engines: ["private-engine"],
      score: 1,
      publishedAt: null,
      thumbnailUrl: null,
    }],
    totalResults: 1,
    warnings: status === "partial"
      ? [{ code: "SEARCH_PROVIDER_ERROR", message: "secret detail", retryable: true }]
      : [],
    trace: {
      correlationId: "private-correlation-id-do-not-store",
      requestedSource: "auto",
      executedSources,
      localSnapshot: null,
    },
  };
}

describe("SearchServingMetrics", () => {
  it("reports observed outcomes, source execution, latency percentiles, and failure reasons", () => {
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const metrics = new SearchServingMetrics(":memory:", () => now);
    stores.push(metrics);

    metrics.recordSuccess(servingResult("ok", ["local"]), 10);
    metrics.recordSuccess(servingResult("ok", ["web"]), 20);
    metrics.recordSuccess(servingResult("partial", ["local", "web"]), 30);
    metrics.recordFailure(
      "web",
      new ReadError("SEARCH_PROVIDER_ERROR", "private provider error"),
      100,
    );

    expect(metrics.getStats(7)).toEqual({
      status: "ok",
      generatedAt: "2026-08-31T12:00:00.000Z",
      since: "2026-08-25T00:00:00.000Z",
      days: 7,
      totals: {
        requests: 4,
        ok: 2,
        partial: 1,
        failed: 1,
        completeRate: 0.5,
        usableRate: 0.75,
      },
      latencyMs: { p50: 20, p95: 100, max: 100 },
      requestedSources: { auto: 3, local: 0, web: 1 },
      executedSources: { local: 1, web: 1, hybrid: 1, unobserved: 1 },
      resultCount: 3,
      warningCount: 1,
      failureReasons: [{ code: "SEARCH_PROVIDER_ERROR", count: 1 }],
    });
  });

  it("persists only bounded structured fields and excludes private search data", () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-search-metrics-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "crawler.sqlite");
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const metrics = new SearchServingMetrics(path, () => now);
    metrics.recordSuccess(servingResult("partial", ["local", "web"]), 25);
    metrics.close();

    const database = new DatabaseSync(path);
    const schema = database.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'search_serving_metrics'",
    ).get();
    const rows = database.prepare("SELECT * FROM search_serving_metrics").all();
    database.close();
    const persisted = JSON.stringify({ schema, rows });
    for (const secret of [
      "PRIVATE QUERY",
      "provider.example",
      "secret.example",
      "do-not-store",
      "PRIVATE TITLE",
      "PRIVATE BODY",
      "private-engine",
      "private-correlation-id",
      "secret detail",
    ]) {
      expect(persisted).not.toContain(secret);
    }

    const reopened = new SearchServingMetrics(path, () => now);
    stores.push(reopened);
    expect(reopened.getStats(1).totals).toMatchObject({ requests: 1, partial: 1 });
  });

  it("returns null latency and rates for an empty window and rejects invalid windows", () => {
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const metrics = new SearchServingMetrics(":memory:", () => now);
    stores.push(metrics);

    expect(metrics.getStats(1)).toMatchObject({
      totals: { requests: 0, completeRate: null, usableRate: null },
      latencyMs: { p50: null, p95: null, max: null },
    });
    expect(() => metrics.getStats(0)).toThrowError(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
    expect(() => metrics.getStats(91)).toThrowError(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
  });
});
