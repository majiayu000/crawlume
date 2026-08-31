import { DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import type {
  SearchServingResult,
  SearchServingStatsResult,
  SearchSource,
} from "./types.js";

type MetricRow = {
  requested_source: SearchSource;
  outcome: "ok" | "partial" | "failed";
  executed_sources: "" | "local" | "web" | "local,web";
  error_code: string;
  duration_ms: number;
  result_count: number;
  warning_count: number;
};

const millisecondsPerDay = 86_400_000;
const maximumStatsDays = 90;

function boundedDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 0;
  return Math.max(0, Math.round(durationMs));
}

function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  return values[Math.ceil(percentile * values.length) - 1] ?? null;
}

export interface SearchServingMetricsRecorder {
  recordSuccess(result: SearchServingResult, durationMs: number): void;
  recordFailure(source: SearchSource, error: ReadError, durationMs: number): void;
}

export class SearchServingMetrics implements SearchServingMetricsRecorder {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly now: () => number = () => Date.now()) {
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS search_serving_metrics (
        id INTEGER PRIMARY KEY,
        occurred_at_ms INTEGER NOT NULL,
        requested_source TEXT NOT NULL CHECK(requested_source IN ('auto','local','web')),
        outcome TEXT NOT NULL CHECK(outcome IN ('ok','partial','failed')),
        executed_sources TEXT NOT NULL CHECK(executed_sources IN ('','local','web','local,web')),
        error_code TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
        result_count INTEGER NOT NULL CHECK(result_count >= 0),
        warning_count INTEGER NOT NULL CHECK(warning_count >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS search_serving_metrics_occurred_at
        ON search_serving_metrics(occurred_at_ms);
    `);
  }

  recordSuccess(result: SearchServingResult, durationMs: number): void {
    this.record({
      requestedSource: result.trace.requestedSource,
      outcome: result.status,
      executedSources: result.trace.executedSources.join(",") as MetricRow["executed_sources"],
      errorCode: "",
      durationMs,
      resultCount: result.results.length,
      warningCount: result.warnings.length,
    });
  }

  recordFailure(source: SearchSource, error: ReadError, durationMs: number): void {
    this.record({
      requestedSource: source,
      outcome: "failed",
      executedSources: "",
      errorCode: error.code,
      durationMs,
      resultCount: 0,
      warningCount: 0,
    });
  }

  getStats(days = 7): SearchServingStatsResult {
    if (!Number.isSafeInteger(days) || days < 1 || days > maximumStatsDays) {
      throw new ReadError(
        "INVALID_ARGUMENT",
        `days must be an integer between 1 and ${maximumStatsDays}.`,
        { details: { days, maximumStatsDays } },
      );
    }
    const now = this.now();
    const currentDay = new Date(now).setUTCHours(0, 0, 0, 0);
    const since = currentDay - (days - 1) * millisecondsPerDay;
    const rows = this.database.prepare(`
      SELECT requested_source, outcome, executed_sources, error_code,
        duration_ms, result_count, warning_count
      FROM search_serving_metrics
      WHERE occurred_at_ms >= ? AND occurred_at_ms <= ?
      ORDER BY duration_ms ASC, id ASC
    `).all(since, now) as MetricRow[];

    const requestedSources = { auto: 0, local: 0, web: 0 };
    const executedSources = { local: 0, web: 0, hybrid: 0, unobserved: 0 };
    const failureCounts = new Map<string, number>();
    let ok = 0;
    let partial = 0;
    let failed = 0;
    let resultCount = 0;
    let warningCount = 0;
    for (const row of rows) {
      requestedSources[row.requested_source] += 1;
      if (row.outcome === "ok") ok += 1;
      if (row.outcome === "partial") partial += 1;
      if (row.outcome === "failed") failed += 1;
      if (row.executed_sources === "local") executedSources.local += 1;
      if (row.executed_sources === "web") executedSources.web += 1;
      if (row.executed_sources === "local,web") executedSources.hybrid += 1;
      if (row.executed_sources === "") executedSources.unobserved += 1;
      if (row.outcome === "failed") {
        failureCounts.set(row.error_code, (failureCounts.get(row.error_code) ?? 0) + 1);
      }
      resultCount += row.result_count;
      warningCount += row.warning_count;
    }
    const requests = rows.length;
    const durations = rows.map((row) => row.duration_ms);
    return {
      status: "ok",
      generatedAt: new Date(now).toISOString(),
      since: new Date(since).toISOString(),
      days,
      totals: {
        requests,
        ok,
        partial,
        failed,
        completeRate: requests === 0 ? null : ok / requests,
        usableRate: requests === 0 ? null : (ok + partial) / requests,
      },
      latencyMs: {
        p50: nearestRank(durations, 0.5),
        p95: nearestRank(durations, 0.95),
        max: durations.at(-1) ?? null,
      },
      requestedSources,
      executedSources,
      resultCount,
      warningCount,
      failureReasons: [...failureCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    };
  }

  close(): void {
    this.database.close();
  }

  private record(input: {
    requestedSource: SearchSource;
    outcome: MetricRow["outcome"];
    executedSources: MetricRow["executed_sources"];
    errorCode: string;
    durationMs: number;
    resultCount: number;
    warningCount: number;
  }): void {
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "DELETE FROM search_serving_metrics WHERE occurred_at_ms < ?",
      ).run(now - maximumStatsDays * millisecondsPerDay);
      this.database.prepare(`
        INSERT INTO search_serving_metrics(
          occurred_at_ms, requested_source, outcome, executed_sources,
          error_code, duration_ms, result_count, warning_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        now,
        input.requestedSource,
        input.outcome,
        input.executedSources,
        input.errorCode,
        boundedDuration(input.durationMs),
        input.resultCount,
        input.warningCount,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
