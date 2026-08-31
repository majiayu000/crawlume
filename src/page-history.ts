import type { DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import type { PageReadArtifact, UrlRedirect } from "./types.js";

type HistoryRow = {
  request_id: string;
  artifact_key: string;
  raw_ref: string;
  requested_url: string;
  final_url: string;
  redirects_json: string;
  declared_canonical_url: string | null;
  content_hash: string;
  fetched_at_ms: number;
  parser_version: string;
  validator_version: string;
  indexer_version: string;
};

type RebuildRow = HistoryRow & {
  result_json: string | null;
  stored_raw_ref: string | null;
};

export const localSearchIndexerVersion = "local-fts-v2";

export type PageIndexPublication = {
  artifactKey: string;
  rawRef: string;
};

export type PageHistoryObservation = {
  requestId: string;
  artifactKey: string;
  rawRef: string;
  requestedUrl: string;
  finalUrl: string;
  redirects: UrlRedirect[];
  declaredCanonicalUrl: string | null;
  contentHash: string;
  fetchedAt: string;
  parserVersion: string;
  validatorVersion: string;
  indexerVersion: string;
};

export type PageContentVersion = {
  artifactKey: string;
  rawRef: string;
  contentHash: string;
  parserVersion: string;
  validatorVersion: string;
  firstObservedAt: string;
  lastObservedAt: string;
  observationCount: number;
};

export type PageHistory = {
  finalUrl: string;
  observations: PageHistoryObservation[];
  versions: PageContentVersion[];
};

export type RecrawlPriority = {
  url: string;
  score: number;
  reason: "unseen" | "history";
  changeRate: number | null;
  staleDays: number | null;
};

export type ProjectionRebuildReport = {
  indexedPages: number;
  indexerVersion: string;
  parserVersions: string[];
};

function observation(row: HistoryRow): PageHistoryObservation {
  return {
    requestId: row.request_id,
    artifactKey: row.artifact_key,
    rawRef: row.raw_ref,
    requestedUrl: row.requested_url,
    finalUrl: row.final_url,
    redirects: JSON.parse(row.redirects_json) as UrlRedirect[],
    declaredCanonicalUrl: row.declared_canonical_url,
    contentHash: row.content_hash,
    fetchedAt: new Date(row.fetched_at_ms).toISOString(),
    parserVersion: row.parser_version,
    validatorVersion: row.validator_version,
    indexerVersion: row.indexer_version,
  };
}

export class PageHistoryStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly maximumDocuments: number,
  ) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS indexed_page_history (
        request_id TEXT PRIMARY KEY,
        artifact_key TEXT NOT NULL,
        raw_ref TEXT NOT NULL,
        requested_url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        redirects_json TEXT NOT NULL,
        declared_canonical_url TEXT,
        content_hash TEXT NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        parser_version TEXT NOT NULL,
        validator_version TEXT NOT NULL,
        indexer_version TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS indexed_page_history_final
        ON indexed_page_history(final_url, fetched_at_ms, request_id);
      CREATE INDEX IF NOT EXISTS indexed_page_history_artifact
        ON indexed_page_history(artifact_key);
    `);
  }

  record(page: PageReadArtifact, publication: PageIndexPublication): void {
    const identity = page.evidence.urlIdentity ?? {
      redirects: [],
      declaredCanonicalUrl: null,
    };
    const values = {
      request_id: page.evidence.requestId,
      artifact_key: publication.artifactKey,
      raw_ref: publication.rawRef,
      requested_url: page.sourceUrl,
      final_url: page.finalUrl,
      redirects_json: JSON.stringify(identity.redirects),
      declared_canonical_url: identity.declaredCanonicalUrl,
      content_hash: page.contentHash,
      fetched_at_ms: Date.parse(page.fetchedAt),
      parser_version: page.evidence.extractorVersion,
      validator_version: page.validation.validatorVersion,
      indexer_version: localSearchIndexerVersion,
    } satisfies HistoryRow;
    const existing = this.database.prepare(
      "SELECT * FROM indexed_page_history WHERE request_id = ?",
    ).get(values.request_id) as HistoryRow | undefined;
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(values)) {
        throw new ReadError(
          "INVALID_ARGUMENT",
          "The request ID already identifies a different page history observation.",
          { details: { requestId: values.request_id } },
        );
      }
      return;
    }
    this.database.prepare(`
      INSERT INTO indexed_page_history(
        request_id, artifact_key, raw_ref, requested_url, final_url,
        redirects_json, declared_canonical_url, content_hash, fetched_at_ms,
        parser_version, validator_version, indexer_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      values.request_id,
      values.artifact_key,
      values.raw_ref,
      values.requested_url,
      values.final_url,
      values.redirects_json,
      values.declared_canonical_url,
      values.content_hash,
      values.fetched_at_ms,
      values.parser_version,
      values.validator_version,
      values.indexer_version,
    );
  }

  history(finalUrl: string): PageHistory {
    const rows = this.database.prepare(`
      SELECT * FROM indexed_page_history
      WHERE final_url = ? ORDER BY fetched_at_ms, request_id
    `).all(finalUrl) as unknown as HistoryRow[];
    const observations = rows.map(observation);
    const versions = new Map<string, PageContentVersion>();
    for (const item of observations) {
      const current = versions.get(item.artifactKey);
      if (current === undefined) {
        versions.set(item.artifactKey, {
          artifactKey: item.artifactKey,
          rawRef: item.rawRef,
          contentHash: item.contentHash,
          parserVersion: item.parserVersion,
          validatorVersion: item.validatorVersion,
          firstObservedAt: item.fetchedAt,
          lastObservedAt: item.fetchedAt,
          observationCount: 1,
        });
      } else {
        current.lastObservedAt = item.fetchedAt;
        current.observationCount += 1;
      }
    }
    return { finalUrl, observations, versions: [...versions.values()] };
  }

  recrawlPriority(url: string, nowMs: number): number {
    return this.priorities(nowMs, [url])[0]?.score ?? 2_000_000;
  }

  recrawlPriorities(now: string, urls: string[]): RecrawlPriority[] {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      throw new ReadError("INVALID_ARGUMENT", "Recrawl priority requires an ISO timestamp.");
    }
    return this.priorities(nowMs, urls);
  }

  rebuildProjection(): ProjectionRebuildReport {
    const rows = this.database.prepare(`
      SELECT history.*, artifacts.result_json,
             raw_objects.raw_ref AS stored_raw_ref
      FROM indexed_page_history AS history
      LEFT JOIN artifacts ON artifacts.artifact_key = history.artifact_key
      LEFT JOIN raw_objects
        ON raw_objects.raw_ref = history.raw_ref
       AND artifacts.raw_ref = raw_objects.raw_ref
      ORDER BY history.final_url, history.fetched_at_ms DESC,
               history.artifact_key DESC, history.request_id DESC
    `).all() as unknown as RebuildRow[];
    const broken = rows.find((row) => row.result_json === null || row.stored_raw_ref === null);
    if (broken !== undefined) {
      throw new ReadError("INTERNAL_ERROR", "Page history references unavailable Raw/Artifact data.", {
        details: { artifactKey: broken.artifact_key, rawRef: broken.raw_ref },
      });
    }
    const latest = new Map<string, { row: RebuildRow; page: PageReadArtifact }>();
    const parserVersions = new Set<string>();
    for (const row of rows) {
      parserVersions.add(row.parser_version);
      if (latest.has(row.final_url)) continue;
      const page = JSON.parse(row.result_json as string) as PageReadArtifact;
      if (
        page.authProfile !== null || page.finalUrl !== row.final_url ||
        page.contentHash !== row.content_hash ||
        page.evidence.extractorVersion !== row.parser_version
      ) {
        throw new ReadError("INTERNAL_ERROR", "Stored Artifact does not match page history.", {
          details: { artifactKey: row.artifact_key, finalUrl: row.final_url },
        });
      }
      latest.set(row.final_url, { row, page });
    }
    if (latest.size > this.maximumDocuments) {
      throw new ReadError("BUDGET_EXHAUSTED", "The rebuilt page projection exceeds capacity.", {
        details: { indexedPages: latest.size, maximumIndexedPages: this.maximumDocuments },
      });
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM indexed_pages");
      const insert = this.database.prepare(`
        INSERT INTO indexed_pages(
          source_url, final_url, title, content_markdown, content_hash,
          fetched_at_ms, published_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { row, page } of latest.values()) {
        insert.run(
          row.requested_url,
          row.final_url,
          page.title,
          page.contentMarkdown,
          row.content_hash,
          row.fetched_at_ms,
          page.publishedTime,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      indexedPages: latest.size,
      indexerVersion: localSearchIndexerVersion,
      parserVersions: [...parserVersions].sort(),
    };
  }

  private priorities(nowMs: number, urls: string[]): RecrawlPriority[] {
    const unique = [...new Set(urls)].map((input) => {
      const url = new URL(input);
      url.hash = "";
      return url.toString();
    });
    const query = this.database.prepare(`
      SELECT content_hash, fetched_at_ms FROM indexed_page_history
      WHERE final_url = ? ORDER BY fetched_at_ms, request_id
    `);
    const priorities = unique.map((url): RecrawlPriority => {
      const rows = query.all(url) as unknown as Array<{
        content_hash: string;
        fetched_at_ms: number;
      }>;
      if (rows.length === 0) {
        return {
          url, score: 2_000_000, reason: "unseen", changeRate: null, staleDays: null,
        };
      }
      let changes = 0;
      for (let index = 1; index < rows.length; index += 1) {
        if (rows[index]?.content_hash !== rows[index - 1]?.content_hash) changes += 1;
      }
      const changeRate = rows.length === 1 ? 0 : changes / (rows.length - 1);
      const lastFetchedAt = rows.at(-1)?.fetched_at_ms ?? nowMs;
      const staleDays = Math.min(365, Math.max(0, Math.floor(
        (nowMs - lastFetchedAt) / 86_400_000,
      )));
      return {
        url,
        score: Math.round(changeRate * 1_000_000) + staleDays,
        reason: "history",
        changeRate,
        staleDays,
      };
    });
    return priorities.sort((left, right) =>
      right.score - left.score || left.url.localeCompare(right.url));
  }
}
