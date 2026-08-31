import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeError, ReadError } from "./errors.js";
import {
  PageHistoryStore,
  type PageHistory,
  type PageIndexPublication,
  type ProjectionRebuildReport,
  type RecrawlPriority,
} from "./page-history.js";
export { localSearchIndexerVersion } from "./page-history.js";
import type { DurableCrawlService } from "./runtime/frontier.js";
import type {
  CrawlJob,
  DurableCrawlOptions,
  PageReadArtifact,
  SearchResult,
  SearchTimeRange,
  SearchWebOptions,
  SearchWebResult,
} from "./types.js";

type CountRow = { count: number };

type SearchRow = {
  final_url: string;
  title: string;
  content_markdown: string;
  published_time: string | null;
};

type VersionRow = {
  content_hash: string;
  fetched_at_ms: number;
  extractor_version: string;
  validator_version: string;
};

export type IndexedPageVersion = {
  contentHash: string;
  fetchedAt: string;
  extractorVersion: string;
  validatorVersion: string;
};

const maximumFtsTerms = 32;

function toFtsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, maximumFtsTerms) ?? [];
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

function timeThreshold(timeRange: SearchTimeRange | undefined): number | null {
  if (timeRange === undefined) {
    return null;
  }
  const days = timeRange === "day" ? 1 : timeRange === "month" ? 30 : 365;
  return Date.now() - days * 24 * 60 * 60 * 1_000;
}

function snippetFrom(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 320);
}

export class LocalPageIndex {
  private readonly database: DatabaseSync;
  private readonly historyStore: PageHistoryStore;

  constructor(path: string, private readonly maximumDocuments = 300_000) {
    if (!Number.isSafeInteger(maximumDocuments) || maximumDocuments <= 0) {
      throw new ReadError("INVALID_ARGUMENT", "maximumDocuments must be a positive integer.");
    }
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS indexed_pages (
        id INTEGER PRIMARY KEY,
        source_url TEXT NOT NULL,
        final_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        published_time TEXT
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS page_index USING fts5(
        title,
        final_url,
        content_markdown,
        content = 'indexed_pages',
        content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS indexed_page_versions (
        final_url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        extractor_version TEXT NOT NULL,
        validator_version TEXT NOT NULL,
        PRIMARY KEY(final_url, content_hash)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS indexed_pages_insert AFTER INSERT ON indexed_pages BEGIN
        INSERT INTO page_index(rowid, title, final_url, content_markdown)
        VALUES (new.id, new.title, new.final_url, new.content_markdown);
      END;
      CREATE TRIGGER IF NOT EXISTS indexed_pages_delete AFTER DELETE ON indexed_pages BEGIN
        INSERT INTO page_index(page_index, rowid, title, final_url, content_markdown)
        VALUES ('delete', old.id, old.title, old.final_url, old.content_markdown);
      END;
      CREATE TRIGGER IF NOT EXISTS indexed_pages_update AFTER UPDATE ON indexed_pages BEGIN
        INSERT INTO page_index(page_index, rowid, title, final_url, content_markdown)
        VALUES ('delete', old.id, old.title, old.final_url, old.content_markdown);
        INSERT INTO page_index(rowid, title, final_url, content_markdown)
        VALUES (new.id, new.title, new.final_url, new.content_markdown);
      END;
    `);
    this.historyStore = new PageHistoryStore(this.database, maximumDocuments);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
  }

  put(page: PageReadArtifact, publication?: PageIndexPublication): void {
    if (page.authProfile !== null) {
      return;
    }
    const existing = this.database.prepare(
      "SELECT 1 FROM indexed_pages WHERE final_url = ?",
    ).get(page.finalUrl);
    if (existing === undefined && this.count() >= this.maximumDocuments) {
      throw new ReadError("BUDGET_EXHAUSTED", "The local page index capacity is exhausted.", {
        details: { maximumIndexedPages: this.maximumDocuments },
      });
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO indexed_pages(
           source_url, final_url, title, content_markdown, content_hash, fetched_at_ms, published_time
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(final_url) DO UPDATE SET
           source_url = excluded.source_url,
           title = excluded.title,
           content_markdown = excluded.content_markdown,
           content_hash = excluded.content_hash,
           fetched_at_ms = excluded.fetched_at_ms,
           published_time = excluded.published_time`,
      ).run(
        page.sourceUrl,
        page.finalUrl,
        page.title,
        page.contentMarkdown,
        page.contentHash,
        Date.parse(page.fetchedAt),
        page.publishedTime,
      );
      this.database.prepare(`
        INSERT OR IGNORE INTO indexed_page_versions(
          final_url, content_hash, fetched_at_ms, extractor_version, validator_version
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        page.finalUrl,
        page.contentHash,
        Date.parse(page.fetchedAt),
        page.evidence.extractorVersion,
        page.validation.validatorVersion,
      );
      if (publication !== undefined) {
        this.historyStore.record(page, publication);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  count(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM indexed_pages").get() as CountRow;
    return row.count;
  }

  versions(finalUrl: string): IndexedPageVersion[] {
    const rows = this.database.prepare(`
      SELECT content_hash, fetched_at_ms, extractor_version, validator_version
      FROM indexed_page_versions WHERE final_url = ?
      ORDER BY fetched_at_ms, content_hash
    `).all(finalUrl) as unknown as VersionRow[];
    return rows.map((row) => ({
      contentHash: row.content_hash,
      fetchedAt: new Date(row.fetched_at_ms).toISOString(),
      extractorVersion: row.extractor_version,
      validatorVersion: row.validator_version,
    }));
  }

  history(finalUrl: string): PageHistory {
    return this.historyStore.history(finalUrl);
  }

  rebuildProjection(): ProjectionRebuildReport {
    return this.historyStore.rebuildProjection();
  }

  recrawlPriority(url: string, nowMs: number): number {
    return this.historyStore.recrawlPriority(url, nowMs);
  }

  recrawlPriorities(now: string, urls: string[]): RecrawlPriority[] {
    return this.historyStore.recrawlPriorities(now, urls);
  }

  search(
    query: string,
    limit: number,
    page: number,
    timeRange?: SearchTimeRange,
  ): SearchResult[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }
    const threshold = timeThreshold(timeRange);
    const rows = this.database
      .prepare(
        `SELECT p.final_url, p.title, p.content_markdown, p.published_time
         FROM page_index
         JOIN indexed_pages AS p ON p.id = page_index.rowid
         WHERE page_index MATCH ?
           AND (? IS NULL OR p.fetched_at_ms >= ?)
         ORDER BY bm25(page_index, 8.0, 3.0, 1.0), p.fetched_at_ms DESC
         LIMIT ? OFFSET ?`,
      )
      .all(ftsQuery, threshold, threshold, limit, (page - 1) * limit) as SearchRow[];
    return rows.map((row) => ({
      title: row.title,
      url: row.final_url,
      snippet: snippetFrom(row.content_markdown),
      source: "local",
      engines: ["diaoyan-local"],
      score: null,
      publishedAt: row.published_time,
      thumbnailUrl: null,
    }));
  }

  close(): void {
    this.database.close();
  }
}

export type VerticalRuntimeSeed = {
  id: string;
  url: string;
  scope: "domain" | "url";
  lastScheduledAt: string | null;
};

export type VerticalRunStatus = "running" | "completed" | "partial" | "failed";

export type VerticalRunJob = {
  seedId: string;
  jobId: string | null;
  status: CrawlJob["status"] | "launch_failed";
  plannedProviderAttempts: number;
  usedProviderAttempts: number;
  error: unknown | null;
};

export type VerticalRun = {
  id: string;
  day: string;
  status: VerticalRunStatus;
  plannedProviderAttempts: number;
  usedProviderAttempts: number;
  indexedPagesAtStart: number;
  completedJobs: number;
  failedJobs: number;
  createdAt: string;
  completedAt: string | null;
  jobs: VerticalRunJob[];
};

export type VerticalQueryEvaluation = {
  query: string;
  expectedUrls: string[];
  resultUrls: string[];
  hitAt10: 0 | 1;
  recallAt10: number;
  reciprocalRank: number;
};

export type VerticalQueryEvaluationReport = {
  evaluatedAt: string;
  queryCount: number;
  hitAt10: number;
  recallAt10: number;
  mrrAt10: number;
  cases: VerticalQueryEvaluation[];
};

type VerticalRunRow = {
  id: string;
  day: string;
  status: VerticalRunStatus;
  planned_provider_attempts: number;
  indexed_pages_at_start: number;
  created_at_ms: number;
  completed_at_ms: number | null;
};

type VerticalRunJobRow = {
  seed_id: string;
  job_id: string | null;
  status: VerticalRunJob["status"];
  planned_provider_attempts: number;
  used_provider_attempts: number;
  error_json: string | null;
};

type VerticalSearchRuntimeDependencies = {
  path: string;
  jobs: Pick<DurableCrawlService, "start" | "get">;
  search: { searchWeb(options: SearchWebOptions): Promise<SearchWebResult> };
  index: Pick<LocalPageIndex, "count" | "recrawlPriority">;
  now: () => number;
  listAdmittedSeeds: () => VerticalRuntimeSeed[];
  markScheduled: (seedIds: string[], scheduledAtMs: number) => void;
  maximumIndexedPages: number;
  maximumDailyProviderAttempts: number;
};

const terminalCrawlStatuses = new Set<CrawlJob["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function crawlOptions(seed: VerticalRuntimeSeed, attempts: number): DurableCrawlOptions {
  return {
    url: seed.url,
    cacheMode: "live",
    maxPages: attempts,
    maxDepth: seed.scope === "domain" ? 2 : 0,
    includeSubdomains: false,
    ignoreQueryParameters: true,
    concurrency: Math.min(4, attempts),
    crawlBudget: {
      maxDurationMs: 86_400_000,
      maxProviderAttempts: attempts,
      maxDocumentBytes: attempts * 50_000_000,
      maxBrowserMs: attempts * 30_000,
      maxBrowserContexts: attempts,
    },
  };
}

function plannedSeeds(
  seeds: VerticalRuntimeSeed[],
  maximumAttempts: number,
  priority: (seed: VerticalRuntimeSeed) => number,
): Array<{ seed: VerticalRuntimeSeed; attempts: number }> {
  const byAge = [...seeds].sort((left, right) => {
    const priorityDifference = priority(right) - priority(left);
    if (priorityDifference !== 0) return priorityDifference;
    const leftTime = left.lastScheduledAt === null ? -1 : Date.parse(left.lastScheduledAt);
    const rightTime = right.lastScheduledAt === null ? -1 : Date.parse(right.lastScheduledAt);
    return leftTime - rightTime || left.id.localeCompare(right.id);
  });
  const exact = byAge.filter((seed) => seed.scope === "url").slice(0, maximumAttempts);
  const plan = exact.map((seed) => ({ seed, attempts: 1 }));
  let remaining = maximumAttempts - exact.length;
  const domains = byAge.filter((seed) => seed.scope === "domain");
  if (remaining === 0 || domains.length === 0) return plan;
  const selected = domains.slice(0, Math.min(domains.length, remaining));
  const base = Math.min(100, Math.floor(remaining / selected.length));
  remaining -= base * selected.length;
  for (const seed of selected) {
    const extra = base < 100 && remaining > 0 ? 1 : 0;
    remaining -= extra;
    plan.push({ seed, attempts: base + extra });
  }
  return plan.filter(({ attempts }) => attempts > 0);
}

export class VerticalSearchRuntime {
  private readonly database: DatabaseSync;

  constructor(private readonly dependencies: VerticalSearchRuntimeDependencies) {
    const { path } = dependencies;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS vertical_search_runs (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed')),
        planned_provider_attempts INTEGER NOT NULL,
        indexed_pages_at_start INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS vertical_search_run_jobs (
        run_id TEXT NOT NULL,
        seed_id TEXT NOT NULL,
        job_id TEXT UNIQUE,
        status TEXT NOT NULL CHECK(status IN (
          'queued','running','paused','completed','failed','cancelled','launch_failed'
        )),
        planned_provider_attempts INTEGER NOT NULL,
        used_provider_attempts INTEGER NOT NULL DEFAULT 0,
        error_json TEXT,
        PRIMARY KEY(run_id, seed_id),
        FOREIGN KEY(run_id) REFERENCES vertical_search_runs(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS vertical_search_queries (
        query TEXT PRIMARY KEY,
        expected_urls_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  startDailyRun(): VerticalRun {
    const now = this.dependencies.now();
    const day = utcDay(now);
    const existing = this.database.prepare("SELECT id FROM vertical_search_runs WHERE day = ?")
      .get(day) as { id: string } | undefined;
    if (existing !== undefined) {
      throw new ReadError("INVALID_ARGUMENT", "A vertical-search run already exists for this UTC day.", {
        details: { day, runId: existing.id },
      });
    }
    const indexedPages = this.dependencies.index.count();
    const remainingPages = this.dependencies.maximumIndexedPages - indexedPages;
    if (remainingPages <= 0) {
      throw new ReadError("BUDGET_EXHAUSTED", "The vertical-search index capacity is exhausted.", {
        details: { indexedPages, maximumIndexedPages: this.dependencies.maximumIndexedPages },
      });
    }
    const seeds = this.dependencies.listAdmittedSeeds();
    if (seeds.length === 0) {
      throw new ReadError("INVALID_ARGUMENT", "No admitted vertical-search seeds are available.");
    }
    const maximumAttempts = Math.min(
      remainingPages,
      this.dependencies.maximumDailyProviderAttempts,
    );
    const plan = plannedSeeds(
      seeds,
      maximumAttempts,
      (seed) => seed.scope === "url"
        ? this.dependencies.index.recrawlPriority(seed.url, now)
        : 0,
    );
    const plannedAttempts = plan.reduce((total, item) => total + item.attempts, 0);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO vertical_search_runs(
        id, day, status, planned_provider_attempts, indexed_pages_at_start, created_at_ms
      ) VALUES (?, ?, 'running', ?, ?, ?)
    `).run(id, day, plannedAttempts, indexedPages, now);
    const launchedSeedIds: string[] = [];
    for (const item of plan) {
      try {
        const job = this.dependencies.jobs.start(crawlOptions(item.seed, item.attempts));
        this.insertRunJob(id, item.seed.id, job.id, job.status, item.attempts, 0, job.error);
        launchedSeedIds.push(item.seed.id);
      } catch (error) {
        const normalized = normalizeError(error);
        this.insertRunJob(
          id,
          item.seed.id,
          null,
          "launch_failed",
          item.attempts,
          0,
          normalized.toJSON(),
        );
      }
    }
    this.dependencies.markScheduled(launchedSeedIds, now);
    return this.summarizeRun(id);
  }

  refreshRun(id: string): VerticalRun {
    this.requireRunRow(id);
    const rows = this.jobRows(id);
    for (const row of rows) {
      if (row.job_id === null || terminalCrawlStatuses.has(row.status as CrawlJob["status"])) {
        continue;
      }
      try {
        const job = this.dependencies.jobs.get(row.job_id);
        if (job.usage === undefined) {
          throw new ReadError("INTERNAL_ERROR", "The durable crawl job is missing usage evidence.", {
            details: { jobId: job.id },
          });
        }
        this.database.prepare(`
          UPDATE vertical_search_run_jobs
          SET status = ?, used_provider_attempts = ?, error_json = ?
          WHERE run_id = ? AND seed_id = ?
        `).run(
          job.status,
          job.usage.providerAttempts,
          job.error === null ? null : JSON.stringify(job.error),
          id,
          row.seed_id,
        );
      } catch (error) {
        const normalized = normalizeError(error);
        this.database.prepare(`
          UPDATE vertical_search_run_jobs
          SET status = 'failed', error_json = ? WHERE run_id = ? AND seed_id = ?
        `).run(JSON.stringify(normalized.toJSON()), id, row.seed_id);
      }
    }
    return this.summarizeRun(id);
  }

  setQueryJudgment(query: string, expectedUrls: string[]): void {
    const now = this.dependencies.now();
    this.database.prepare(`
      INSERT INTO vertical_search_queries(query, expected_urls_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(query) DO UPDATE SET
        expected_urls_json = excluded.expected_urls_json,
        updated_at_ms = excluded.updated_at_ms
    `).run(query, JSON.stringify(expectedUrls), now, now);
  }

  async evaluateQuerySet(): Promise<VerticalQueryEvaluationReport> {
    const judgments = this.database.prepare(`
      SELECT query, expected_urls_json FROM vertical_search_queries ORDER BY rowid
    `).all() as unknown as Array<{ query: string; expected_urls_json: string }>;
    if (judgments.length === 0) {
      throw new ReadError("INVALID_ARGUMENT", "No vertical-search query judgments are configured.");
    }
    const cases: VerticalQueryEvaluation[] = [];
    for (const judgment of judgments) {
      const expectedUrls = JSON.parse(judgment.expected_urls_json) as string[];
      const response = await this.dependencies.search.searchWeb({
        query: judgment.query,
        source: "local",
        limit: 10,
        page: 1,
      });
      const resultUrls = response.results.map((result) => {
        const parsed = new URL(result.url);
        parsed.hash = "";
        return parsed.toString();
      });
      const expected = new Set(expectedUrls);
      const relevantRanks = resultUrls.flatMap((url, index) => expected.has(url) ? [index + 1] : []);
      const matched = new Set(resultUrls.filter((url) => expected.has(url))).size;
      cases.push({
        query: judgment.query,
        expectedUrls,
        resultUrls,
        hitAt10: matched > 0 ? 1 : 0,
        recallAt10: matched / expected.size,
        reciprocalRank: relevantRanks[0] === undefined ? 0 : 1 / relevantRanks[0],
      });
    }
    const mean = (values: number[]): number =>
      values.reduce((total, value) => total + value, 0) / values.length;
    return {
      evaluatedAt: new Date(this.dependencies.now()).toISOString(),
      queryCount: cases.length,
      hitAt10: mean(cases.map((item) => item.hitAt10)),
      recallAt10: mean(cases.map((item) => item.recallAt10)),
      mrrAt10: mean(cases.map((item) => item.reciprocalRank)),
      cases,
    };
  }

  close(): void {
    this.database.close();
  }

  private summarizeRun(id: string): VerticalRun {
    const refreshed = this.jobRows(id);
    const running = refreshed.some((row) =>
      row.status !== "launch_failed" && !terminalCrawlStatuses.has(row.status as CrawlJob["status"]));
    const completed = refreshed.filter((row) => row.status === "completed").length;
    const failed = refreshed.length - completed - (running
      ? refreshed.filter((row) =>
          row.status !== "launch_failed" && !terminalCrawlStatuses.has(row.status as CrawlJob["status"]),
        ).length
      : 0);
    if (!running) {
      const status: VerticalRunStatus = completed === refreshed.length
        ? "completed"
        : completed === 0 ? "failed" : "partial";
      this.database.prepare(`
        UPDATE vertical_search_runs SET status = ?, completed_at_ms = ? WHERE id = ?
      `).run(status, this.dependencies.now(), id);
    }
    return this.publicRun(id, completed, failed);
  }

  private insertRunJob(
    runId: string,
    seedId: string,
    jobId: string | null,
    status: VerticalRunJob["status"],
    plannedAttempts: number,
    usedAttempts: number,
    error: unknown,
  ): void {
    this.database.prepare(`
      INSERT INTO vertical_search_run_jobs(
        run_id, seed_id, job_id, status, planned_provider_attempts,
        used_provider_attempts, error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      seedId,
      jobId,
      status,
      plannedAttempts,
      usedAttempts,
      error === null ? null : JSON.stringify(error),
    );
  }

  private requireRunRow(id: string): VerticalRunRow {
    const row = this.database.prepare("SELECT * FROM vertical_search_runs WHERE id = ?")
      .get(id) as VerticalRunRow | undefined;
    if (row === undefined) {
      throw new ReadError("JOB_NOT_FOUND", "The vertical-search run does not exist.", {
        details: { runId: id },
      });
    }
    return row;
  }

  private jobRows(id: string): VerticalRunJobRow[] {
    return this.database.prepare(`
      SELECT seed_id, job_id, status, planned_provider_attempts,
             used_provider_attempts, error_json
      FROM vertical_search_run_jobs WHERE run_id = ? ORDER BY rowid
    `).all(id) as unknown as VerticalRunJobRow[];
  }

  private publicRun(id: string, completedJobs: number, failedJobs: number): VerticalRun {
    const row = this.requireRunRow(id);
    const jobs = this.jobRows(id).map((job): VerticalRunJob => ({
      seedId: job.seed_id,
      jobId: job.job_id,
      status: job.status,
      plannedProviderAttempts: job.planned_provider_attempts,
      usedProviderAttempts: job.used_provider_attempts,
      error: job.error_json === null ? null : JSON.parse(job.error_json) as unknown,
    }));
    return {
      id: row.id,
      day: row.day,
      status: row.status,
      plannedProviderAttempts: row.planned_provider_attempts,
      usedProviderAttempts: jobs.reduce((total, job) => total + job.usedProviderAttempts, 0),
      indexedPagesAtStart: row.indexed_pages_at_start,
      completedJobs,
      failedJobs,
      createdAt: new Date(row.created_at_ms).toISOString(),
      completedAt: row.completed_at_ms === null ? null : new Date(row.completed_at_ms).toISOString(),
      jobs,
    };
  }
}
