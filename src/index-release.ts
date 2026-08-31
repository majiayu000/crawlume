import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import { localSearchIndexerVersion } from "./page-history.js";
import type { PageReadArtifact } from "./types.js";

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

export const localIndexReleaseSchemaVersion = "local-index-release-v1";

export type LocalIndexReleaseDocument = {
  finalUrl: string;
  requestId: string;
  artifactKey: string;
  rawRef: string;
  contentHash: string;
  projectionHash: `sha256:${string}`;
  parserVersion: string;
  validatorVersion: string;
};

export type LocalIndexReleaseManifest = {
  schemaVersion: typeof localIndexReleaseSchemaVersion;
  indexerVersion: typeof localSearchIndexerVersion;
  documentCount: number;
  documents: LocalIndexReleaseDocument[];
};

export type LocalIndexRelease = {
  id: string;
  manifestHash: string;
  status: "complete";
  createdAt: string;
  active: boolean;
  manifest: LocalIndexReleaseManifest;
};

type ReleaseRow = {
  release_id: string;
  manifest_hash: string;
  manifest_json: string;
  status: "building" | "complete";
  created_at_ms: number;
};

type ReleaseProjectionRow = {
  source_url: string;
  final_url: string;
  title: string;
  content_markdown: string;
  content_hash: string;
  fetched_at_ms: number;
  published_time: string | null;
};

type ReleaseDependencyRow = HistoryRow & {
  result_json: string | null;
  stored_raw_ref: string | null;
  stored_raw_bytes: Uint8Array | null;
};

function releaseManifestHash(manifestJson: string): string {
  return `sha256:${createHash("sha256").update(manifestJson).digest("hex")}`;
}

function releaseId(hash: string): string {
  return `release_${hash.slice("sha256:".length)}`;
}

function releaseProjectionHash(projection: {
  sourceUrl: string;
  finalUrl: string;
  title: string;
  contentMarkdown: string;
  contentHash: string;
  fetchedAtMs: number;
  publishedTime: string | null;
}): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`;
}

function releaseIntegrityError(
  message: string,
  details: Record<string, string> = {},
): ReadError {
  return new ReadError("INTERNAL_ERROR", message, { details });
}

function releaseArtifact(row: ReleaseDependencyRow): PageReadArtifact {
  if (
    row.result_json === null || row.stored_raw_ref === null || row.stored_raw_bytes === null
  ) {
    throw releaseIntegrityError("Index release references unavailable Raw/Artifact data.", {
      artifactKey: row.artifact_key,
      rawRef: row.raw_ref,
    });
  }
  const actualRawRef = `sha256:${createHash("sha256").update(row.stored_raw_bytes).digest("hex")}`;
  if (actualRawRef !== row.raw_ref) {
    throw releaseIntegrityError("Index release Raw content failed address verification.", {
      rawRef: row.raw_ref,
    });
  }
  try {
    return JSON.parse(row.result_json) as PageReadArtifact;
  } catch (error) {
    throw new ReadError("INTERNAL_ERROR", "Index release references a malformed Artifact.", {
      details: { artifactKey: row.artifact_key },
      cause: error,
    });
  }
}

function assertReleaseDocument(
  document: LocalIndexReleaseDocument,
  row: ReleaseDependencyRow,
  page: PageReadArtifact,
): void {
  if (
    row.request_id !== document.requestId ||
    row.artifact_key !== document.artifactKey ||
    row.raw_ref !== document.rawRef ||
    row.final_url !== document.finalUrl ||
    row.content_hash !== document.contentHash ||
    row.parser_version !== document.parserVersion ||
    row.validator_version !== document.validatorVersion ||
    row.indexer_version !== localSearchIndexerVersion ||
    page.authProfile !== null ||
    page.sourceUrl !== row.requested_url ||
    page.finalUrl !== document.finalUrl ||
    page.contentHash !== document.contentHash ||
    Date.parse(page.fetchedAt) !== row.fetched_at_ms ||
    page.evidence.extractorVersion !== document.parserVersion ||
    page.validation.validatorVersion !== document.validatorVersion ||
    releaseProjectionHash({
      sourceUrl: row.requested_url,
      finalUrl: row.final_url,
      title: page.title,
      contentMarkdown: page.contentMarkdown,
      contentHash: row.content_hash,
      fetchedAtMs: row.fetched_at_ms,
      publishedTime: page.publishedTime,
    }) !== document.projectionHash
  ) {
    throw releaseIntegrityError("Index release content does not match its persisted dependencies.", {
      finalUrl: document.finalUrl,
      artifactKey: document.artifactKey,
    });
  }
}

export class LocalIndexReleaseStore {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly maximumDocuments = 300_000) {
    if (!Number.isSafeInteger(maximumDocuments) || maximumDocuments <= 0) {
      throw new ReadError("INVALID_ARGUMENT", "maximumDocuments must be a positive integer.");
    }
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS local_index_releases (
        release_id TEXT PRIMARY KEY,
        manifest_hash TEXT NOT NULL UNIQUE,
        manifest_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('building','complete')),
        created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS local_index_active_release (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        release_id TEXT NOT NULL,
        activated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS local_index_releases_immutable_update
      BEFORE UPDATE ON local_index_releases BEGIN
        SELECT RAISE(ABORT, 'local index release manifests are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS local_index_releases_immutable_delete
      BEFORE DELETE ON local_index_releases BEGIN
        SELECT RAISE(ABORT, 'local index release manifests are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS indexed_pages_insert_invalidates_active_release
      AFTER INSERT ON indexed_pages BEGIN
        DELETE FROM local_index_active_release WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS indexed_pages_update_invalidates_active_release
      AFTER UPDATE ON indexed_pages BEGIN
        DELETE FROM local_index_active_release WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS indexed_pages_delete_invalidates_active_release
      AFTER DELETE ON indexed_pages BEGIN
        DELETE FROM local_index_active_release WHERE singleton = 1;
      END;
    `);
  }

  createRelease(): LocalIndexRelease {
    return this.transaction("Index release creation failed.", () => {
      const rows = this.database.prepare(`
        SELECT source_url, final_url, title, content_markdown, content_hash,
               fetched_at_ms, published_time
        FROM indexed_pages ORDER BY final_url
      `).all() as unknown as ReleaseProjectionRow[];
      if (rows.length === 0) {
        throw new ReadError("INVALID_ARGUMENT", "Cannot create a release from an empty index.");
      }
      const documents = rows.map((row) => this.documentForProjection(row));
      const manifest: LocalIndexReleaseManifest = {
        schemaVersion: localIndexReleaseSchemaVersion,
        indexerVersion: localSearchIndexerVersion,
        documentCount: documents.length,
        documents,
      };
      const manifestJson = JSON.stringify(manifest);
      const hash = releaseManifestHash(manifestJson);
      const id = releaseId(hash);
      if (this.releaseRow(id) !== undefined) {
        throw new ReadError("INVALID_ARGUMENT", "This local index manifest is already released.", {
          details: { releaseId: id },
        });
      }
      const createdAtMs = Date.now();
      this.database.prepare(`
        INSERT INTO local_index_releases(
          release_id, manifest_hash, manifest_json, status, created_at_ms
        ) VALUES (?, ?, ?, 'complete', ?)
      `).run(id, hash, manifestJson, createdAtMs);
      return {
        id,
        manifestHash: hash,
        status: "complete",
        createdAt: new Date(createdAtMs).toISOString(),
        active: false,
        manifest,
      };
    });
  }

  activeRelease(): LocalIndexRelease | null {
    const active = this.activeReleaseId();
    if (active === null) return null;
    const row = this.releaseRow(active);
    if (row === undefined || row.status !== "complete") {
      throw releaseIntegrityError("The active local index release is unavailable or incomplete.", {
        releaseId: active,
      });
    }
    const manifest = this.parseManifest(row);
    for (const document of manifest.documents) this.rebuildDocument(document);
    return this.publicRelease(row, true, manifest);
  }

  activateRelease(id: string): LocalIndexRelease {
    return this.applyRelease(id, false);
  }

  rollbackRelease(id: string): LocalIndexRelease {
    return this.applyRelease(id, true);
  }

  close(): void {
    this.database.close();
  }

  private applyRelease(id: string, rollback: boolean): LocalIndexRelease {
    return this.transaction(
      rollback ? "Local index rollback failed." : "Local index activation failed.",
      () => {
        const current = this.activeReleaseId();
        if (rollback && current === null) {
          throw new ReadError("INVALID_ARGUMENT", "Rollback requires an active local index release.");
        }
        if (rollback && current === id) {
          throw new ReadError("INVALID_ARGUMENT", "Rollback target is already active.", {
            details: { releaseId: id },
          });
        }
        const row = this.requireCompleteRow(id);
        const manifest = this.parseManifest(row);
        const documents = manifest.documents.map((document) => this.rebuildDocument(document));
        if (documents.length > this.maximumDocuments) {
          throw new ReadError("BUDGET_EXHAUSTED", "The release exceeds local index capacity.", {
            details: {
              releaseId: id,
              indexedPages: documents.length,
              maximumIndexedPages: this.maximumDocuments,
            },
          });
        }
        this.database.exec("DELETE FROM indexed_pages");
        const insert = this.database.prepare(`
          INSERT INTO indexed_pages(
            source_url, final_url, title, content_markdown, content_hash,
            fetched_at_ms, published_time
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const { row: dependency, page } of documents) {
          insert.run(
            dependency.requested_url,
            dependency.final_url,
            page.title,
            page.contentMarkdown,
            dependency.content_hash,
            dependency.fetched_at_ms,
            page.publishedTime,
          );
        }
        this.database.prepare(`
          INSERT INTO local_index_active_release(singleton, release_id, activated_at_ms)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            release_id = excluded.release_id,
            activated_at_ms = excluded.activated_at_ms
        `).run(id, Date.now());
        return this.publicRelease(row, true, manifest);
      },
    );
  }

  private documentForProjection(projection: ReleaseProjectionRow): LocalIndexReleaseDocument {
    const row = this.database.prepare(`
      SELECT history.*, artifacts.result_json,
             raw_objects.raw_ref AS stored_raw_ref,
             raw_objects.bytes AS stored_raw_bytes
      FROM indexed_page_history AS history
      LEFT JOIN artifacts ON artifacts.artifact_key = history.artifact_key
      LEFT JOIN raw_objects
        ON raw_objects.raw_ref = history.raw_ref
       AND artifacts.raw_ref = raw_objects.raw_ref
      WHERE history.final_url = ? AND history.content_hash = ? AND history.fetched_at_ms = ?
      ORDER BY history.artifact_key DESC, history.request_id DESC LIMIT 1
    `).get(
      projection.final_url,
      projection.content_hash,
      projection.fetched_at_ms,
    ) as ReleaseDependencyRow | undefined;
    if (row === undefined) {
      throw releaseIntegrityError(
        "The current projection has no complete page history observation.",
        { finalUrl: projection.final_url },
      );
    }
    const page = releaseArtifact(row);
    const document: LocalIndexReleaseDocument = {
      finalUrl: row.final_url,
      requestId: row.request_id,
      artifactKey: row.artifact_key,
      rawRef: row.raw_ref,
      contentHash: row.content_hash,
      projectionHash: releaseProjectionHash({
        sourceUrl: projection.source_url,
        finalUrl: projection.final_url,
        title: projection.title,
        contentMarkdown: projection.content_markdown,
        contentHash: projection.content_hash,
        fetchedAtMs: projection.fetched_at_ms,
        publishedTime: projection.published_time,
      }),
      parserVersion: row.parser_version,
      validatorVersion: row.validator_version,
    };
    assertReleaseDocument(document, row, page);
    if (
      projection.source_url !== row.requested_url ||
      projection.title !== page.title ||
      projection.content_markdown !== page.contentMarkdown ||
      projection.published_time !== page.publishedTime
    ) {
      throw releaseIntegrityError("The current projection does not match its release Artifact.", {
        finalUrl: projection.final_url,
      });
    }
    return document;
  }

  private rebuildDocument(
    document: LocalIndexReleaseDocument,
  ): { row: ReleaseDependencyRow; page: PageReadArtifact } {
    const row = this.database.prepare(`
      SELECT history.*, artifacts.result_json,
             raw_objects.raw_ref AS stored_raw_ref,
             raw_objects.bytes AS stored_raw_bytes
      FROM indexed_page_history AS history
      LEFT JOIN artifacts ON artifacts.artifact_key = history.artifact_key
      LEFT JOIN raw_objects
        ON raw_objects.raw_ref = history.raw_ref
       AND artifacts.raw_ref = raw_objects.raw_ref
      WHERE history.request_id = ?
    `).get(document.requestId) as ReleaseDependencyRow | undefined;
    if (row === undefined) {
      throw releaseIntegrityError("Index release references a missing page history observation.", {
        requestId: document.requestId,
      });
    }
    const page = releaseArtifact(row);
    assertReleaseDocument(document, row, page);
    return { row, page };
  }

  private parseManifest(row: ReleaseRow): LocalIndexReleaseManifest {
    if (
      releaseManifestHash(row.manifest_json) !== row.manifest_hash ||
      releaseId(row.manifest_hash) !== row.release_id
    ) {
      throw releaseIntegrityError("Stored local index release manifest failed hash verification.", {
        releaseId: row.release_id,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(row.manifest_json);
    } catch (error) {
      throw new ReadError("INTERNAL_ERROR", "Stored local index release manifest is malformed.", {
        details: { releaseId: row.release_id },
        cause: error,
      });
    }
    if (
      value === null || typeof value !== "object" ||
      !("schemaVersion" in value) || value.schemaVersion !== localIndexReleaseSchemaVersion ||
      !("indexerVersion" in value) || value.indexerVersion !== localSearchIndexerVersion ||
      !("documentCount" in value) || !Number.isSafeInteger(value.documentCount) ||
      !("documents" in value) || !Array.isArray(value.documents) ||
      value.documentCount !== value.documents.length || value.documents.length === 0
    ) {
      throw releaseIntegrityError("Stored local index release manifest violates its schema.", {
        releaseId: row.release_id,
      });
    }
    const manifest = value as LocalIndexReleaseManifest;
    const validDocuments = manifest.documents.every((document) =>
      document !== null && typeof document === "object" &&
      typeof document.finalUrl === "string" && typeof document.requestId === "string" &&
      typeof document.artifactKey === "string" && typeof document.rawRef === "string" &&
      typeof document.contentHash === "string" &&
      typeof document.projectionHash === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(document.projectionHash) &&
      typeof document.parserVersion === "string" &&
      typeof document.validatorVersion === "string");
    const orderedUrls = manifest.documents.map((document) => document.finalUrl);
    if (
      !validDocuments || new Set(orderedUrls).size !== orderedUrls.length ||
      orderedUrls.some((url, index) => index > 0 && url <= orderedUrls[index - 1]!)
    ) {
      throw releaseIntegrityError("Stored local index release manifest has invalid document entries.", {
        releaseId: row.release_id,
      });
    }
    return manifest;
  }

  private publicRelease(
    row: ReleaseRow,
    active: boolean,
    manifest = this.parseManifest(row),
  ): LocalIndexRelease {
    if (row.status !== "complete") {
      throw releaseIntegrityError("Stored local index release is incomplete.", {
        releaseId: row.release_id,
      });
    }
    return {
      id: row.release_id,
      manifestHash: row.manifest_hash,
      status: "complete",
      createdAt: new Date(row.created_at_ms).toISOString(),
      active,
      manifest,
    };
  }

  private requireCompleteRow(id: string): ReleaseRow {
    const row = this.releaseRow(id);
    if (row === undefined) {
      throw new ReadError("INVALID_ARGUMENT", "The requested local index release does not exist.", {
        details: { releaseId: id },
      });
    }
    if (row.status !== "complete") {
      throw new ReadError("INVALID_ARGUMENT", "The requested local index release is incomplete.", {
        details: { releaseId: id },
      });
    }
    return row;
  }

  private releaseRow(id: string): ReleaseRow | undefined {
    return this.database.prepare(
      "SELECT * FROM local_index_releases WHERE release_id = ?",
    ).get(id) as ReleaseRow | undefined;
  }

  private activeReleaseId(): string | null {
    const row = this.database.prepare(
      "SELECT release_id FROM local_index_active_release WHERE singleton = 1",
    ).get() as { release_id: string } | undefined;
    return row?.release_id ?? null;
  }

  private transaction<T>(message: string, operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new ReadError("INTERNAL_ERROR", `${message} Transaction rollback also failed.`, {
          cause: new AggregateError([error, rollbackError]),
        });
      }
      if (error instanceof ReadError) throw error;
      throw new ReadError("INTERNAL_ERROR", message, { cause: error });
    }
  }
}
