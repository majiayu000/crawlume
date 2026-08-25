import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { PageReadArtifact, SearchResult, SearchTimeRange } from "./types.js";

type CountRow = { count: number };

type SearchRow = {
  final_url: string;
  title: string;
  content_markdown: string;
  published_time: string | null;
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

  constructor(path: string) {
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
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
  }

  put(page: PageReadArtifact): void {
    if (page.authProfile !== null) {
      return;
    }
    this.database
      .prepare(
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
      )
      .run(
        page.sourceUrl,
        page.finalUrl,
        page.title,
        page.contentMarkdown,
        page.contentHash,
        Date.parse(page.fetchedAt),
        page.publishedTime,
      );
  }

  count(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM indexed_pages").get() as CountRow;
    return row.count;
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
