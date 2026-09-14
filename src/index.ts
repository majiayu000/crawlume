import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import {
  PageHistoryStore,
  type PageHistory,
  type PageIndexPublication,
  type ProjectionRebuildReport,
  type RecrawlPriority,
} from "./page-history.js";
export { localSearchIndexerVersion } from "./page-history.js";
import { toFtsQuery } from "./search-query.js";
import type {
  PageReadArtifact,
  SearchResult,
  SearchTimeRange,
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
      engines: ["crawlume-local"],
      score: null,
      publishedAt: row.published_time,
      thumbnailUrl: null,
    }));
  }

  close(): void {
    this.database.close();
  }
}
