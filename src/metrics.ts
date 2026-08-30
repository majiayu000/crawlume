import { DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import type {
  AccessPlanEvidence,
  AccessProviderId,
  CrawlerStatsDay,
  CrawlerStatsResult,
  PlannedStageReasonCode,
  ReadPageResult,
  RequestTerminalState,
  ResourceUsage,
  StageResult,
} from "./types.js";

type CacheStatus = keyof CrawlerStatsResult["cache"];

type MetricRow = {
  day: string;
  outcome: "success" | "failure";
  error_code: string;
  fetch_method: string;
  cache_status: string;
  planner_version: string;
  extractor_version: string;
  validator_version: string;
  final_state: RequestTerminalState;
  request_count: number;
  response_bytes: number;
  content_characters: number;
  attempts: number;
  retry_delay_ms: number;
  duration_ms: number;
  extraction_duration_ms: number;
  validation_duration_ms: number;
};

type TransitionRow = {
  planner_version: string;
  stage_id: string;
  provider: AccessProviderId;
  reason_code: PlannedStageReasonCode;
  transition_count: number;
};

type AttemptMetricRow = {
  stage_id: string;
  provider: AccessProviderId;
  provider_version: string;
  outcome: StageResult["outcome"];
  usage_json: string;
  started_at: string;
  completed_at: string;
};

type CrawlMetricRow = {
  jobs: number;
  discovered_pages: number;
  published_pages: number;
  succeeded_pages: number;
  failed_pages: number;
  stopped_pages: number;
};

type MetricValues = {
  outcome: "success" | "failure";
  errorCode: string;
  fetchMethod: string;
  cacheStatus: CacheStatus | null;
  plannerVersion: string;
  extractorVersion: string;
  validatorVersion: string;
  finalState: RequestTerminalState;
  responseBytes: number;
  contentCharacters: number;
  attempts: number;
  retryDelayMs: number;
  durationMs: number;
  extractionDurationMs: number;
  validationDurationMs: number;
  execution: AccessPlanEvidence | null;
};

type StageAggregate = CrawlerStatsResult["stages"][number];

const millisecondsPerDay = 86_400_000;
const cacheStatuses = ["live", "fresh", "revalidated", "stale", "replayed"] as const;
const terminalStates = [
  "completed",
  "completed_uncertain",
  "invalid",
  "failed",
  "policy_stop",
  "budget_exhausted",
  "cancelled",
] as const satisfies readonly RequestTerminalState[];

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

function emptyUsage(): ResourceUsage {
  return {
    documentBytesIn: 0,
    networkBytesOut: 0,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryDelayMilliseconds: 0,
    optionalModelTokens: 0,
  };
}

function addUsage(target: ResourceUsage, source: ResourceUsage): void {
  target.documentBytesIn += source.documentBytesIn;
  target.networkBytesOut += source.networkBytesOut;
  target.browserMilliseconds += source.browserMilliseconds;
  target.browserContextStarts += source.browserContextStarts;
  target.retryDelayMilliseconds += source.retryDelayMilliseconds;
  target.optionalModelTokens += source.optionalModelTokens;
}

function emptyFinalStates(): Record<RequestTerminalState, number> {
  return Object.fromEntries(terminalStates.map((state) => [state, 0])) as
    Record<RequestTerminalState, number>;
}

function emptyCache(): Record<CacheStatus, number> {
  return Object.fromEntries(cacheStatuses.map((status) => [status, 0])) as
    Record<CacheStatus, number>;
}

function countedVersions(counts: Map<string, number>): Array<{ version: string; count: number }> {
  return [...counts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((left, right) => left.version.localeCompare(right.version));
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
}

function executedTransitions(execution: AccessPlanEvidence | null): AccessPlanEvidence["plannedStages"] {
  if (execution === null) return [];
  const executed = new Set(execution.executedStages);
  return execution.plannedStages.filter((stage) => executed.has(stage.stageId));
}

export class CrawlerMetrics {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly now: () => number = () => Date.now()) {
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS runtime_metrics_daily (
        day TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
        error_code TEXT NOT NULL,
        fetch_method TEXT NOT NULL,
        cache_status TEXT NOT NULL CHECK(cache_status IN ('','live','fresh','revalidated','stale','replayed')),
        planner_version TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        validator_version TEXT NOT NULL,
        final_state TEXT NOT NULL CHECK(final_state IN (
          'completed','completed_uncertain','invalid','failed','policy_stop','budget_exhausted','cancelled'
        )),
        request_count INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        content_characters INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        retry_delay_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        extraction_duration_ms REAL NOT NULL,
        validation_duration_ms REAL NOT NULL,
        PRIMARY KEY(
          day, outcome, error_code, fetch_method, cache_status, planner_version,
          extractor_version, validator_version, final_state
        )
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runtime_transition_metrics_daily (
        day TEXT NOT NULL,
        planner_version TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        transition_count INTEGER NOT NULL,
        PRIMARY KEY(day, planner_version, stage_id, provider, reason_code)
      ) STRICT;
    `);
  }

  recordSuccess(result: ReadPageResult, durationMs: number): void {
    if (result.validation.outcome === "invalid") {
      throw new ReadError("INTERNAL_ERROR", "An invalid artifact cannot be recorded as success.");
    }
    const cached = result.cached;
    this.record({
      outcome: "success",
      errorCode: "",
      fetchMethod: result.fetchMethod,
      cacheStatus: result.evidence.cacheStatus ?? (cached ? "fresh" : "live"),
      plannerVersion: result.evidence.accessPlan.plannerVersion,
      extractorVersion: result.evidence.extractorVersion,
      validatorVersion: result.evidence.validatorVersion,
      finalState: result.validation.outcome === "valid" ? "completed" : "completed_uncertain",
      responseBytes: cached ? 0 : nonnegativeInteger(result.evidence.responseBytes),
      contentCharacters: nonnegativeInteger(result.evidence.contentCharacters),
      attempts: cached ? 0 : nonnegativeInteger(result.evidence.attempts ?? 1),
      retryDelayMs: cached ? 0 : nonnegativeInteger(result.evidence.totalRetryDelayMs),
      durationMs: nonnegativeInteger(Math.round(durationMs)),
      extractionDurationMs: cached ? 0 : (result.evidence.phaseDurationsMs?.extraction ?? 0),
      validationDurationMs: cached ? 0 : (result.evidence.phaseDurationsMs?.validation ?? 0),
      execution: result.evidence.accessPlan,
    });
  }

  recordFailure(
    error: ReadError,
    durationMs: number,
    finalState: Exclude<RequestTerminalState, "completed" | "completed_uncertain">,
  ): void {
    this.record({
      outcome: "failure",
      errorCode: error.code,
      fetchMethod: "",
      cacheStatus: null,
      plannerVersion: error.execution?.plannerVersion ?? "",
      extractorVersion: typeof error.details.extractorVersion === "string"
        ? error.details.extractorVersion
        : "",
      validatorVersion: typeof error.details.validatorVersion === "string"
        ? error.details.validatorVersion
        : "",
      finalState,
      responseBytes: 0,
      contentCharacters: 0,
      attempts: nonnegativeInteger(error.details.attempts),
      retryDelayMs: nonnegativeInteger(error.details.totalRetryDelayMs),
      durationMs: nonnegativeInteger(Math.round(durationMs)),
      extractionDurationMs: typeof error.details.extractionDurationMs === "number"
        ? error.details.extractionDurationMs
        : 0,
      validationDurationMs: typeof error.details.validationDurationMs === "number"
        ? error.details.validationDurationMs
        : 0,
      execution: error.execution,
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
    const todayStart = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
    const sinceMs = todayStart - (days - 1) * millisecondsPerDay;
    const sinceDay = utcDay(sinceMs);
    const throughDay = utcDay(todayStart);
    const rows = this.database.prepare(`
      SELECT day, outcome, error_code, fetch_method, cache_status, planner_version,
             extractor_version, validator_version, final_state, request_count,
             response_bytes, content_characters, attempts, retry_delay_ms, duration_ms,
             extraction_duration_ms, validation_duration_ms
      FROM runtime_metrics_daily
      WHERE day BETWEEN ? AND ?
      ORDER BY day, outcome, error_code, fetch_method, cache_status
    `).all(sinceDay, throughDay) as unknown as MetricRow[];

    const dailyByDate = new Map<string, CrawlerStatsDay>();
    for (let offset = 0; offset < days; offset += 1) {
      const date = utcDay(sinceMs + offset * millisecondsPerDay);
      dailyByDate.set(date, emptyDay(date));
    }
    const failureCounts = new Map<string, number>();
    const plannerVersions = new Map<string, number>();
    const extractorVersions = new Map<string, number>();
    const validatorVersions = new Map<string, number>();
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
      finalStates: emptyFinalStates(),
      cache: emptyCache(),
      versions: { planners: [], providers: [], extractors: [], validators: [] },
      stages: [],
      resources: emptyUsage(),
      phaseDurationsMs: { provider: 0, extraction: 0, validation: 0, endToEnd: 0 },
      transitions: [],
      crawlCoverage: {
        jobs: 0,
        discoveredPages: 0,
        publishedPages: 0,
        succeededPages: 0,
        failedPages: 0,
        stoppedPages: 0,
        coverageRate: null,
      },
      daily: [],
    };

    for (const row of rows) {
      const daily = dailyByDate.get(row.day);
      if (daily === undefined) continue;
      result.totals.requests += row.request_count;
      daily.requests += row.request_count;
      result.finalStates[row.final_state] += row.request_count;
      if (row.planner_version !== "") {
        plannerVersions.set(
          row.planner_version,
          (plannerVersions.get(row.planner_version) ?? 0) + row.request_count,
        );
      }
      if (row.extractor_version !== "") {
        extractorVersions.set(
          row.extractor_version,
          (extractorVersions.get(row.extractor_version) ?? 0) + row.request_count,
        );
      }
      if (row.validator_version !== "") {
        validatorVersions.set(
          row.validator_version,
          (validatorVersions.get(row.validator_version) ?? 0) + row.request_count,
        );
      }
      if (row.outcome === "success") {
        result.totals.successes += row.request_count;
        daily.successes += row.request_count;
        const status = row.cache_status as CacheStatus;
        result.cache[status] += row.request_count;
        if (status !== "live") {
          result.totals.cacheHits += row.request_count;
          daily.cacheHits += row.request_count;
        } else if (row.fetch_method === "http" || row.fetch_method === "browser") {
          result.fetchMethods[row.fetch_method] += row.request_count;
        }
      } else {
        result.totals.failures += row.request_count;
        daily.failures += row.request_count;
        failureCounts.set(row.error_code, (failureCounts.get(row.error_code) ?? 0) + row.request_count);
      }
      result.cost.responseBytes += row.response_bytes;
      result.cost.contentCharacters += row.content_characters;
      result.cost.attempts += row.attempts;
      result.cost.retryDelayMs += row.retry_delay_ms;
      result.cost.durationMs += row.duration_ms;
      result.phaseDurationsMs.extraction += row.extraction_duration_ms;
      result.phaseDurationsMs.validation += row.validation_duration_ms;
      result.phaseDurationsMs.endToEnd += row.duration_ms;
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
    result.versions.planners = countedVersions(plannerVersions);
    result.versions.extractors = countedVersions(extractorVersions);
    result.versions.validators = countedVersions(validatorVersions);
    result.transitions = this.readTransitions(sinceDay, throughDay);
    this.projectAttempts(result, sinceDay, throughDay);
    result.crawlCoverage = this.readCrawlCoverage(sinceMs, todayStart + millisecondsPerDay);
    result.daily = [...dailyByDate.values()];
    return result;
  }

  close(): void {
    this.database.close();
  }

  private record(values: MetricValues): void {
    const day = utcDay(this.now());
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO runtime_metrics_daily(
          day, outcome, error_code, fetch_method, cache_status, planner_version,
          extractor_version, validator_version, final_state, request_count,
          response_bytes, content_characters, attempts, retry_delay_ms, duration_ms,
          extraction_duration_ms, validation_duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          day, outcome, error_code, fetch_method, cache_status, planner_version,
          extractor_version, validator_version, final_state
        ) DO UPDATE SET
          request_count = request_count + 1,
          response_bytes = response_bytes + excluded.response_bytes,
          content_characters = content_characters + excluded.content_characters,
          attempts = attempts + excluded.attempts,
          retry_delay_ms = retry_delay_ms + excluded.retry_delay_ms,
          duration_ms = duration_ms + excluded.duration_ms,
          extraction_duration_ms = extraction_duration_ms + excluded.extraction_duration_ms,
          validation_duration_ms = validation_duration_ms + excluded.validation_duration_ms
      `).run(
        day,
        values.outcome,
        values.errorCode,
        values.fetchMethod,
        values.cacheStatus ?? "",
        values.plannerVersion,
        values.extractorVersion,
        values.validatorVersion,
        values.finalState,
        values.responseBytes,
        values.contentCharacters,
        values.attempts,
        values.retryDelayMs,
        values.durationMs,
        values.extractionDurationMs,
        values.validationDurationMs,
      );
      for (const stage of executedTransitions(values.execution)) {
        this.database.prepare(`
          INSERT INTO runtime_transition_metrics_daily(
            day, planner_version, stage_id, provider, reason_code, transition_count
          ) VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(day, planner_version, stage_id, provider, reason_code)
          DO UPDATE SET transition_count = transition_count + 1
        `).run(
          day,
          values.execution?.plannerVersion ?? "",
          stage.stageId,
          stage.provider,
          stage.reasonCode,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readTransitions(sinceDay: string, throughDay: string): CrawlerStatsResult["transitions"] {
    const rows = this.database.prepare(`
      SELECT planner_version, stage_id, provider, reason_code,
             SUM(transition_count) AS transition_count
      FROM runtime_transition_metrics_daily
      WHERE day BETWEEN ? AND ?
      GROUP BY planner_version, stage_id, provider, reason_code
      ORDER BY stage_id, provider, reason_code, planner_version
    `).all(sinceDay, throughDay) as unknown as TransitionRow[];
    return rows.map((row) => ({
      plannerVersion: row.planner_version,
      stageId: row.stage_id,
      provider: row.provider,
      reasonCode: row.reason_code,
      count: row.transition_count,
    }));
  }

  private projectAttempts(result: CrawlerStatsResult, sinceDay: string, throughDay: string): void {
    if (!tableExists(this.database, "execution_attempts")) return;
    const rows = this.database.prepare(`
      SELECT stage_id, provider, provider_version, outcome, usage_json, started_at, completed_at
      FROM execution_attempts
      WHERE substr(recorded_at, 1, 10) BETWEEN ? AND ?
      ORDER BY stage_id, provider, provider_version, outcome
    `).all(sinceDay, throughDay) as unknown as AttemptMetricRow[];
    const stages = new Map<string, StageAggregate>();
    const providerVersions = new Map<string, {
      provider: AccessProviderId;
      version: string;
      count: number;
    }>();
    for (const row of rows) {
      const usage = JSON.parse(row.usage_json) as ResourceUsage;
      addUsage(result.resources, usage);
      const providerKey = `${row.provider}\u0000${row.provider_version}`;
      const provider = providerVersions.get(providerKey) ?? {
        provider: row.provider,
        version: row.provider_version,
        count: 0,
      };
      provider.count += 1;
      providerVersions.set(providerKey, provider);
      const stageKey = `${row.stage_id}\u0000${row.provider}\u0000${row.provider_version}\u0000${row.outcome}`;
      const stage = stages.get(stageKey) ?? {
        stageId: row.stage_id,
        provider: row.provider,
        providerVersion: row.provider_version,
        outcome: row.outcome,
        attempts: 0,
        durationMs: 0,
        resources: emptyUsage(),
      };
      stage.attempts += 1;
      stage.durationMs += Math.max(0, Date.parse(row.completed_at) - Date.parse(row.started_at));
      addUsage(stage.resources, usage);
      stages.set(stageKey, stage);
    }
    result.versions.providers = [...providerVersions.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.version.localeCompare(right.version)
    );
    result.stages = [...stages.values()];
    result.phaseDurationsMs.provider = result.stages.reduce(
      (total, stage) => total + stage.durationMs,
      0,
    );
  }

  private readCrawlCoverage(sinceMs: number, throughMs: number): CrawlerStatsResult["crawlCoverage"] {
    const empty: CrawlerStatsResult["crawlCoverage"] = {
      jobs: 0,
      discoveredPages: 0,
      publishedPages: 0,
      succeededPages: 0,
      failedPages: 0,
      stoppedPages: 0,
      coverageRate: null,
    };
    if (!tableExists(this.database, "crawl_jobs")) return empty;
    const row = this.database.prepare(`
      SELECT COUNT(*) AS jobs,
             COALESCE(SUM(discovered_count), 0) AS discovered_pages,
             COALESCE(SUM(published_count), 0) AS published_pages,
             COALESCE(SUM(succeeded_count), 0) AS succeeded_pages,
             COALESCE(SUM(failed_count), 0) AS failed_pages,
             COALESCE(SUM(stopped_count), 0) AS stopped_pages
      FROM crawl_jobs
      WHERE completed_at_ms >= ? AND completed_at_ms < ?
    `).get(sinceMs, throughMs) as CrawlMetricRow;
    return {
      jobs: row.jobs,
      discoveredPages: row.discovered_pages,
      publishedPages: row.published_pages,
      succeededPages: row.succeeded_pages,
      failedPages: row.failed_pages,
      stoppedPages: row.stopped_pages,
      coverageRate: row.discovered_pages === 0 ? null : row.published_pages / row.discovered_pages,
    };
  }
}
