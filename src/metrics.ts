import { DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import type { CrawlerStatsDay, CrawlerStatsResult, ReadPageResult } from "./types.js";

type MetricRow = {
  day: string;
  outcome: "success" | "failure";
  error_code: string;
  fetch_method: string;
  cached: number;
  request_count: number;
  response_bytes: number;
  content_characters: number;
  attempts: number;
  retry_delay_ms: number;
  duration_ms: number;
};

type MetricValues = {
  outcome: "success" | "failure";
  errorCode: string;
  fetchMethod: string;
  cached: boolean;
  responseBytes: number;
  contentCharacters: number;
  attempts: number;
  retryDelayMs: number;
  durationMs: number;
};

const millisecondsPerDay = 86_400_000;

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function emptyDay(date: string): CrawlerStatsDay {
  return {
    date,
    requests: 0,
    successes: 0,
    failures: 0,
    cacheHits: 0,
    responseBytes: 0,
    durationMs: 0,
  };
}

export class CrawlerMetrics {
  private readonly database: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS crawler_metrics_daily (
        day TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
        error_code TEXT NOT NULL,
        fetch_method TEXT NOT NULL,
        cached INTEGER NOT NULL CHECK(cached IN (0, 1)),
        request_count INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        content_characters INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        retry_delay_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        PRIMARY KEY(day, outcome, error_code, fetch_method, cached)
      ) STRICT;
    `);
  }

  recordSuccess(result: ReadPageResult, durationMs: number): void {
    const cached = result.cached;
    this.record({
      outcome: "success",
      errorCode: "",
      fetchMethod: result.fetchMethod,
      cached,
      responseBytes: cached ? 0 : nonnegativeInteger(result.evidence.responseBytes),
      contentCharacters: nonnegativeInteger(result.evidence.contentCharacters),
      attempts: cached ? 0 : nonnegativeInteger(result.evidence.attempts ?? 1),
      retryDelayMs: cached ? 0 : nonnegativeInteger(result.evidence.totalRetryDelayMs),
      durationMs: nonnegativeInteger(Math.round(durationMs)),
    });
  }

  recordFailure(error: ReadError, durationMs: number): void {
    this.record({
      outcome: "failure",
      errorCode: error.code,
      fetchMethod: "",
      cached: false,
      responseBytes: 0,
      contentCharacters: 0,
      attempts: nonnegativeInteger(error.details.attempts),
      retryDelayMs: nonnegativeInteger(error.details.totalRetryDelayMs),
      durationMs: nonnegativeInteger(Math.round(durationMs)),
    });
  }

  getStats(days = 7): CrawlerStatsResult {
    if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
      throw new ReadError("INVALID_ARGUMENT", "days must be an integer between 1 and 90.", {
        details: { days },
      });
    }
    const generatedAtMs = this.now();
    const generatedAt = new Date(generatedAtMs).toISOString();
    const current = new Date(generatedAtMs);
    const todayStart = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate(),
    );
    const sinceMs = todayStart - (days - 1) * millisecondsPerDay;
    const sinceDay = utcDay(sinceMs);
    const rows = this.database
      .prepare(
        `SELECT day, outcome, error_code, fetch_method, cached, request_count,
                response_bytes, content_characters, attempts, retry_delay_ms, duration_ms
         FROM crawler_metrics_daily
         WHERE day BETWEEN ? AND ?
         ORDER BY day, outcome, error_code, fetch_method, cached`,
      )
      .all(sinceDay, utcDay(todayStart)) as unknown as MetricRow[];

    const dailyByDate = new Map<string, CrawlerStatsDay>();
    for (let offset = 0; offset < days; offset += 1) {
      const date = utcDay(sinceMs + offset * millisecondsPerDay);
      dailyByDate.set(date, emptyDay(date));
    }
    const failureCounts = new Map<string, number>();
    const result: CrawlerStatsResult = {
      status: "ok",
      generatedAt,
      since: new Date(sinceMs).toISOString(),
      days,
      totals: {
        requests: 0,
        successes: 0,
        failures: 0,
        successRate: null,
        cacheHits: 0,
        cacheHitRate: null,
      },
      fetchMethods: { http: 0, browser: 0 },
      cost: {
        responseBytes: 0,
        contentCharacters: 0,
        attempts: 0,
        retryDelayMs: 0,
        durationMs: 0,
      },
      failureReasons: [],
      daily: [],
    };

    for (const row of rows) {
      const daily = dailyByDate.get(row.day);
      if (daily === undefined) {
        continue;
      }
      result.totals.requests += row.request_count;
      daily.requests += row.request_count;
      if (row.outcome === "success") {
        result.totals.successes += row.request_count;
        daily.successes += row.request_count;
        if (row.cached === 1) {
          result.totals.cacheHits += row.request_count;
          daily.cacheHits += row.request_count;
        }
        if (
          row.cached === 0 &&
          (row.fetch_method === "http" || row.fetch_method === "browser")
        ) {
          result.fetchMethods[row.fetch_method] += row.request_count;
        }
      } else {
        result.totals.failures += row.request_count;
        daily.failures += row.request_count;
        failureCounts.set(
          row.error_code,
          (failureCounts.get(row.error_code) ?? 0) + row.request_count,
        );
      }
      result.cost.responseBytes += row.response_bytes;
      result.cost.contentCharacters += row.content_characters;
      result.cost.attempts += row.attempts;
      result.cost.retryDelayMs += row.retry_delay_ms;
      result.cost.durationMs += row.duration_ms;
      daily.responseBytes += row.response_bytes;
      daily.durationMs += row.duration_ms;
    }

    if (result.totals.requests > 0) {
      result.totals.successRate = result.totals.successes / result.totals.requests;
    }
    if (result.totals.successes > 0) {
      result.totals.cacheHitRate = result.totals.cacheHits / result.totals.successes;
    }
    result.failureReasons = [...failureCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
    result.daily = [...dailyByDate.values()];
    return result;
  }

  close(): void {
    this.database.close();
  }

  private record(values: MetricValues): void {
    this.database
      .prepare(
        `INSERT INTO crawler_metrics_daily(
           day, outcome, error_code, fetch_method, cached, request_count,
           response_bytes, content_characters, attempts, retry_delay_ms, duration_ms
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(day, outcome, error_code, fetch_method, cached) DO UPDATE SET
           request_count = request_count + 1,
           response_bytes = response_bytes + excluded.response_bytes,
           content_characters = content_characters + excluded.content_characters,
           attempts = attempts + excluded.attempts,
           retry_delay_ms = retry_delay_ms + excluded.retry_delay_ms,
           duration_ms = duration_ms + excluded.duration_ms`,
      )
      .run(
        utcDay(this.now()),
        values.outcome,
        values.errorCode,
        values.fetchMethod,
        values.cached ? 1 : 0,
        values.responseBytes,
        values.contentCharacters,
        values.attempts,
        values.retryDelayMs,
        values.durationMs,
      );
  }
}
