import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { PageReadArtifact, RawPage, ReadIntent, RslEvidence } from "./types.js";

const CACHE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const CACHE_MAX_ARTIFACTS = 10_000;

type CacheRow = {
  result_json: string;
};

type CacheLookupRow = CacheRow & {
  artifact_key: string;
  raw_ref: string;
  fetched_at_ms: number;
  etag: string | null;
  last_modified: string | null;
};

type RawRow = {
  raw_ref: string;
  media_type: string;
  bytes: Uint8Array;
  retention_class: "shared";
};

export type StoredRawObject = {
  ref: string;
  mediaType: string;
  bytes: Uint8Array;
  retentionClass: "shared";
};

export type ArtifactStorageIdentity = {
  intent: ReadIntent;
  approvalContextHash: string;
  rawRef: string;
  extractorVersion: string;
};

export type CacheValidators = {
  etag?: string;
  lastModified?: string;
};

export type CacheLookup = {
  artifact: PageReadArtifact;
  artifactKey: string;
  rawRef: string;
  validatedAtMs: number;
  etag?: string;
  lastModified?: string;
};

export type CacheCleanupResult = {
  projectionsDeleted: number;
  terminalProjectionsDeleted: number;
  artifactsDeleted: number;
  rawObjectsDeleted: number;
};

type SharedFlight = {
  controller: AbortController;
  promise: Promise<unknown>;
  subscribers: number;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function rawBytes(page: RawPage): Uint8Array {
  return page.bodyBytes ?? new Uint8Array(Buffer.from(page.body));
}

function rawReference(page: RawPage): string {
  return `sha256:${createHash("sha256").update(rawBytes(page)).digest("hex")}`;
}

function isRestricted(profileId: string | null, rsl: RslEvidence | undefined): boolean {
  return profileId !== null || (rsl?.approvalsApplied ?? 0) > 0 ||
    (rsl?.licenseTokensApplied ?? 0) > 0;
}

function artifactReference(
  result: PageReadArtifact,
  identity: ArtifactStorageIdentity,
): string {
  return `artifact:${digest({
    schema: "artifact-v1",
    rawRef: identity.rawRef,
    contentHash: result.contentHash,
    intent: identity.intent,
    authorizationContextHash: digest(identity.intent.authorization),
    licenseContextHash: digest({
      approvalContextHash: identity.approvalContextHash,
      rsl: result.evidence.rsl ?? null,
    }),
    extractorVersion: identity.extractorVersion,
    validatorVersion: result.validation.validatorVersion,
  })}`;
}

export class PageCache {
  private readonly database: DatabaseSync;
  private readonly flights = new Map<string, SharedFlight>();

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS raw_objects (
        raw_ref TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        bytes BLOB NOT NULL,
        retention_class TEXT NOT NULL CHECK(retention_class = 'shared'),
        created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_key TEXT PRIMARY KEY,
        raw_ref TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifact_cache_entries (
        cache_key TEXT PRIMARY KEY,
        artifact_key TEXT NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        etag TEXT,
        last_modified TEXT,
        FOREIGN KEY(artifact_key) REFERENCES artifacts(artifact_key)
      ) STRICT;
    `);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
      this.cleanup({
        ttlSeconds: CACHE_RETENTION_SECONDS,
        maxArtifacts: CACHE_MAX_ARTIFACTS,
      });
    }
  }

  get(cacheKey: string, maxAgeSeconds: number): PageReadArtifact | null {
    const entry = this.lookup(cacheKey);
    if (entry === null || entry.validatedAtMs < Date.now() - maxAgeSeconds * 1_000) return null;
    return entry.artifact;
  }

  getStale(
    cacheKey: string,
    maxAgeSeconds: number,
    staleWhileRevalidateSeconds: number,
  ): PageReadArtifact | null {
    const entry = this.lookup(cacheKey);
    if (entry === null) return null;
    const ageMs = Date.now() - entry.validatedAtMs;
    if (
      ageMs <= maxAgeSeconds * 1_000 ||
      ageMs > (maxAgeSeconds + staleWhileRevalidateSeconds) * 1_000
    ) {
      return null;
    }
    return entry.artifact;
  }

  lookup(cacheKey: string): CacheLookup | null {
    const row = this.database.prepare(
      `SELECT artifacts.result_json, artifacts.raw_ref,
              artifact_cache_entries.artifact_key, artifact_cache_entries.fetched_at_ms,
              artifact_cache_entries.etag, artifact_cache_entries.last_modified
       FROM artifact_cache_entries
       JOIN artifacts USING(artifact_key)
       WHERE artifact_cache_entries.cache_key = ?`,
    ).get(cacheKey) as CacheLookupRow | undefined;
    if (row === undefined) return null;
    return {
      artifact: JSON.parse(row.result_json) as PageReadArtifact,
      artifactKey: row.artifact_key,
      rawRef: row.raw_ref,
      validatedAtMs: row.fetched_at_ms,
      ...(row.etag === null ? {} : { etag: row.etag }),
      ...(row.last_modified === null ? {} : { lastModified: row.last_modified }),
    };
  }

  markRevalidated(
    cacheKey: string,
    validators: CacheValidators = {},
    validatedAtMs = Date.now(),
  ): PageReadArtifact | null {
    const update = this.database.prepare(
      `UPDATE artifact_cache_entries
       SET fetched_at_ms = ?,
           etag = COALESCE(?, etag),
           last_modified = COALESCE(?, last_modified)
       WHERE cache_key = ?`,
    ).run(
      validatedAtMs,
      validators.etag ?? null,
      validators.lastModified ?? null,
      cacheKey,
    );
    if (update.changes === 0) return null;
    return this.lookup(cacheKey)?.artifact ?? null;
  }

  storeRaw(page: RawPage, intent: ReadIntent): string {
    const ref = rawReference(page);
    if (isRestricted(intent.authorization.profileId, page.rsl)) return ref;
    this.database.prepare(
      `INSERT OR IGNORE INTO raw_objects(
        raw_ref, media_type, bytes, retention_class, created_at_ms
      ) VALUES (?, ?, ?, 'shared', ?)`,
    ).run(ref, page.contentType, rawBytes(page), Date.now());
    return ref;
  }

  getRaw(ref: string): StoredRawObject | null {
    const row = this.database.prepare(
      `SELECT raw_ref, media_type, bytes, retention_class
       FROM raw_objects WHERE raw_ref = ?`,
    ).get(ref) as RawRow | undefined;
    if (row === undefined) return null;
    return {
      ref: row.raw_ref,
      mediaType: row.media_type,
      bytes: new Uint8Array(row.bytes),
      retentionClass: row.retention_class,
    };
  }

  getArtifact(artifactKey: string): PageReadArtifact | null {
    const row = this.database.prepare(
      "SELECT result_json FROM artifacts WHERE artifact_key = ?",
    ).get(artifactKey) as CacheRow | undefined;
    return row === undefined ? null : JSON.parse(row.result_json) as PageReadArtifact;
  }

  put(
    cacheKey: string,
    result: PageReadArtifact,
    identity: ArtifactStorageIdentity,
    validators: CacheValidators = {},
  ): string | null {
    if (
      isRestricted(identity.intent.authorization.profileId, result.evidence.rsl) ||
      result.authProfile !== null
    ) {
      return null;
    }
    const artifactKey = artifactReference(result, identity);
    const identityJson = JSON.stringify(canonicalize({
      ...identity,
      validatorVersion: result.validation.validatorVersion,
    }));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT OR IGNORE INTO artifacts(
          artifact_key, raw_ref, identity_json, result_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        artifactKey,
        identity.rawRef,
        identityJson,
        JSON.stringify(result),
        Date.now(),
      );
      this.database
        .prepare(
          `INSERT INTO artifact_cache_entries(
             cache_key, artifact_key, fetched_at_ms, etag, last_modified
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             artifact_key = excluded.artifact_key,
             fetched_at_ms = excluded.fetched_at_ms,
             etag = excluded.etag,
             last_modified = excluded.last_modified`,
        )
        .run(
          cacheKey,
          artifactKey,
          Date.parse(result.fetchedAt),
          validators.etag ?? null,
          validators.lastModified ?? null,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return artifactKey;
  }

  cleanup(options: { ttlSeconds: number; maxArtifacts: number }): CacheCleanupResult {
    if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 0) {
      throw new RangeError("ttlSeconds must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(options.maxArtifacts) || options.maxArtifacts < 0) {
      throw new RangeError("maxArtifacts must be a non-negative integer.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let projectionsDeleted = Number(this.database.prepare(
        "DELETE FROM artifact_cache_entries WHERE fetched_at_ms < ?",
      ).run(Date.now() - options.ttlSeconds * 1_000).changes);
      projectionsDeleted += Number(this.database.prepare(
        `DELETE FROM artifact_cache_entries
         WHERE cache_key IN (
           SELECT cache_key FROM artifact_cache_entries
           ORDER BY fetched_at_ms DESC, cache_key DESC
           LIMIT -1 OFFSET ?
         )`,
      ).run(options.maxArtifacts).changes);
      let terminalProjectionsDeleted = 0;
      const hasTerminalTable = this.database.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get("execution_request_terminals") !== undefined;
      if (hasTerminalTable) {
        terminalProjectionsDeleted += Number(this.database.prepare(
          "DELETE FROM execution_request_terminals WHERE committed_at < ?",
        ).run(new Date(Date.now() - options.ttlSeconds * 1_000).toISOString()).changes);
        terminalProjectionsDeleted += Number(this.database.prepare(`
          DELETE FROM execution_request_terminals
          WHERE artifact_key IS NOT NULL
            AND artifact_key NOT IN (SELECT artifact_key FROM artifact_cache_entries)
        `).run().changes);
      }
      const artifactsDeleted = Number(this.database.prepare(
        `DELETE FROM artifacts
         WHERE artifact_key NOT IN (SELECT artifact_key FROM artifact_cache_entries)`,
      ).run().changes);
      const rawObjectsDeleted = Number(this.database.prepare(
        `DELETE FROM raw_objects
         WHERE raw_ref NOT IN (SELECT raw_ref FROM artifacts)`,
      ).run().changes);
      this.database.exec("COMMIT");
      return {
        projectionsDeleted,
        terminalProjectionsDeleted,
        artifactsDeleted,
        rawObjectsDeleted,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async singleflight<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    let flight = this.flights.get(key);
    if (flight === undefined) {
      const controller = new AbortController();
      const promise = operation(controller.signal);
      flight = { controller, promise, subscribers: 0 };
      this.flights.set(key, flight);
      void promise.then(
        () => {
          if (this.flights.get(key) === flight) this.flights.delete(key);
        },
        () => {
          if (this.flights.get(key) === flight) this.flights.delete(key);
        },
      );
    }
    flight.subscribers += 1;
    try {
      if (callerSignal === undefined) return await flight.promise as T;
      if (callerSignal.aborted) throw this.abortError();
      return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
          callerSignal.removeEventListener("abort", onAbort);
          reject(this.abortError());
        };
        callerSignal.addEventListener("abort", onAbort, { once: true });
        void flight?.promise.then(
          (value) => {
            callerSignal.removeEventListener("abort", onAbort);
            resolve(value as T);
          },
          (error: unknown) => {
            callerSignal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    } finally {
      flight.subscribers -= 1;
      if (flight.subscribers === 0 && this.flights.get(key) === flight) {
        flight.controller.abort();
      }
    }
  }

  private abortError(): Error {
    const error = new Error("The cache-coalesced request was cancelled.");
    error.name = "AbortError";
    return error;
  }

  close(): void {
    this.database.close();
  }
}
