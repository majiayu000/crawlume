import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { PageReadArtifact } from "./types.js";

type CacheRow = {
  result_json: string;
};

export class PageCache {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS page_cache (
        cache_key TEXT PRIMARY KEY,
        fetched_at_ms INTEGER NOT NULL,
        result_json TEXT NOT NULL
      ) STRICT;
    `);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
  }

  get(cacheKey: string, maxAgeSeconds: number): PageReadArtifact | null {
    const threshold = Date.now() - maxAgeSeconds * 1_000;
    const row = this.database
      .prepare(
        `SELECT result_json
         FROM page_cache
         WHERE cache_key = ? AND fetched_at_ms >= ?`,
      )
      .get(cacheKey, threshold) as CacheRow | undefined;
    if (row === undefined) {
      return null;
    }
    return JSON.parse(row.result_json) as PageReadArtifact;
  }

  put(cacheKey: string, result: PageReadArtifact): void {
    this.database
      .prepare(
        `INSERT INTO page_cache(cache_key, fetched_at_ms, result_json)
         VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           fetched_at_ms = excluded.fetched_at_ms,
           result_json = excluded.result_json`,
      )
      .run(cacheKey, Date.parse(result.fetchedAt), JSON.stringify(result));
  }

  close(): void {
    this.database.close();
  }
}
