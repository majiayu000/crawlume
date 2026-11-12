import { randomUUID } from "node:crypto";

import type { ControlPlaneDatabase, ControlPlaneQuery } from "./project-scope.js";

// Project-scoped generic storage: append-only datasets of JSON items and named key-value stores.

type ProjectRef = Readonly<{ projectId: string }>;

const storageNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const recordKeyPattern = /^[A-Za-z0-9!._'()*-]{1,256}$/u;
export const maxDatasetItemsPerAppend = 1_000;
export const maxDatasetItemsPerRead = 10_000;
export const defaultKeyValueRecordMaxBytes = 1_024 * 1_024;

export class StorageInputError extends Error {
  readonly code = "STORAGE_REQUEST_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "StorageInputError";
  }
}

export class DatasetNotFoundError extends Error {
  readonly code = "DATASET_NOT_FOUND";
  constructor() {
    super("The dataset does not exist in this Project.");
    this.name = "DatasetNotFoundError";
  }
}

export class KeyValueStoreNotFoundError extends Error {
  readonly code = "KEY_VALUE_STORE_NOT_FOUND";
  constructor() {
    super("The key-value store does not exist in this Project.");
    this.name = "KeyValueStoreNotFoundError";
  }
}

export class KeyValueRecordNotFoundError extends Error {
  readonly code = "KEY_VALUE_RECORD_NOT_FOUND";
  constructor() {
    super("The key-value record does not exist.");
    this.name = "KeyValueRecordNotFoundError";
  }
}

export class KeyValueRecordTooLargeError extends Error {
  readonly code = "KEY_VALUE_RECORD_TOO_LARGE";
  constructor(readonly maxBytes: number) {
    super(`Key-value records are limited to ${maxBytes} bytes.`);
    this.name = "KeyValueRecordTooLargeError";
  }
}

export type Dataset = Readonly<{
  id: string;
  name: string;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type DatasetItem = Readonly<{ sequence: number; item: Readonly<Record<string, unknown>> }>;

export type KeyValueStore = Readonly<{ id: string; name: string; createdAt: Date }>;

export type KeyValueRecordMetadata = Readonly<{
  key: string;
  contentType: string;
  byteCount: number;
  updatedAt: Date;
}>;

export type KeyValueRecord = KeyValueRecordMetadata & Readonly<{ value: Buffer }>;

type DatasetRow = {
  id: string;
  name: string;
  item_count: number | string;
  created_at: Date;
  updated_at: Date;
};

type RecordRow = {
  key: string;
  content_type: string;
  byte_count: number | string;
  updated_at: Date;
  value?: Buffer;
};

export function keyValueRecordMaxBytesFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const raw = environment.DIAOYAN_KV_MAX_RECORD_BYTES;
  if (raw === undefined || raw === "") return defaultKeyValueRecordMaxBytes;
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 64 * 1_024 * 1_024) {
    throw new Error("DIAOYAN_KV_MAX_RECORD_BYTES must be an integer between 1 and 67108864.");
  }
  return bytes;
}

export function requireStorageName(name: string, field: string): void {
  if (typeof name !== "string" || !storageNamePattern.test(name)) {
    throw new StorageInputError(`${field} must be 1-63 lowercase letters, digits or hyphens.`);
  }
}

function requireRecordKey(key: string): void {
  if (!recordKeyPattern.test(key)) {
    throw new StorageInputError("The record key must be 1-256 URL-safe characters.");
  }
}

function requireLimit(limit: number, maximum: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new StorageInputError(`limit must be an integer from 1 to ${maximum}.`);
  }
}

function dataset(row: DatasetRow): Dataset {
  return Object.freeze({
    id: row.id, name: row.name, itemCount: Number(row.item_count),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function recordMetadata(row: RecordRow): KeyValueRecordMetadata {
  return Object.freeze({
    key: row.key, contentType: row.content_type, byteCount: Number(row.byte_count), updatedAt: row.updated_at,
  });
}

function itemJson(item: unknown): string {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new StorageInputError("Every dataset item must be a JSON object.");
  }
  return JSON.stringify(item);
}

/** Returns the dataset ID, creating the dataset when the name is new to the Project. */
export async function ensureDataset(
  transaction: ControlPlaneQuery,
  projectId: string,
  name: string,
): Promise<string> {
  requireStorageName(name, "dataset");
  const result = await transaction.query<{ id: string }>(`
    INSERT INTO datasets(id, project_id, name) VALUES ($1, $2, $3)
    ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [randomUUID(), projectId, name]);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("The dataset upsert returned no row.");
  return id;
}

/** Appends items in order; the dataset row lock keeps sequences contiguous under concurrent writers. */
async function appendDatasetItems(
  transaction: ControlPlaneQuery,
  projectId: string,
  datasetId: string,
  items: readonly string[],
): Promise<Dataset> {
  const locked = await transaction.query<DatasetRow>(`
    SELECT * FROM datasets WHERE id = $1 AND project_id = $2 FOR UPDATE
  `, [datasetId, projectId]);
  const row = locked.rows[0];
  if (row === undefined) throw new DatasetNotFoundError();
  await transaction.query(`
    INSERT INTO dataset_items(project_id, dataset_id, sequence, item)
    SELECT $1, $2, $3::bigint + entries.ordinality, entries.item
    FROM unnest($4::jsonb[]) WITH ORDINALITY AS entries(item, ordinality)
  `, [projectId, datasetId, Number(row.item_count), items]);
  const updated = await transaction.query<DatasetRow>(`
    UPDATE datasets SET item_count = item_count + $3, updated_at = clock_timestamp()
    WHERE id = $1 AND project_id = $2
    RETURNING *
  `, [datasetId, projectId, items.length]);
  return dataset(updated.rows[0] as DatasetRow);
}

/** Records a completed Job in its output dataset with a reference to its latest published Artifact. */
export async function appendJobResultItem(
  transaction: ControlPlaneQuery,
  projectId: string,
  datasetId: string,
  jobId: string,
  leaseId: string,
): Promise<void> {
  const summary = await transaction.query<{ item: Record<string, unknown> }>(`
    SELECT jsonb_build_object(
      'job_id', jobs.id,
      'type', jobs.type,
      'url', jobs.input->>'url',
      'result_completeness', jobs.result_completeness,
      'completed_at', jobs.completed_at,
      'http_status', (
        SELECT page_status FROM job_events
        WHERE job_events.job_id = jobs.id AND job_events.project_id = jobs.project_id
          AND job_events.page_status IS NOT NULL
        ORDER BY sequence DESC LIMIT 1
      ),
      'artifact', (
        SELECT jsonb_build_object(
          'id', artifact_metadata.id,
          'media_type', artifact_metadata.media_type,
          'byte_count', artifact_metadata.byte_count,
          'content_hash', translate(rtrim(encode(artifact_metadata.content_hash, 'base64'), '='), '+/', '-_'),
          'storage', artifact_metadata.storage_kind
        )
        FROM job_publications
        INNER JOIN artifact_metadata ON artifact_metadata.id = job_publications.artifact_id
          AND artifact_metadata.project_id = job_publications.project_id
        WHERE job_publications.lease_id = $3 AND job_publications.project_id = jobs.project_id
        ORDER BY job_publications.sequence DESC LIMIT 1
      )
    ) AS item
    FROM jobs WHERE jobs.id = $1 AND jobs.project_id = $2
  `, [jobId, projectId, leaseId]);
  const item = summary.rows[0]?.item;
  if (item === undefined) throw new Error("The completed Job could not be summarized.");
  await appendDatasetItems(transaction, projectId, datasetId, [JSON.stringify(item)]);
}

export class DatasetService {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async list(
    scope: ProjectRef,
    input: Readonly<{ after: string | null; limit: number }>,
  ): Promise<readonly Dataset[]> {
    requireLimit(input.limit, 101);
    const result = await this.database.query<DatasetRow>(`
      SELECT * FROM datasets
      WHERE project_id = $1 AND ($2::text IS NULL OR name > $2)
      ORDER BY name LIMIT $3
    `, [scope.projectId, input.after, input.limit]);
    return result.rows.map(dataset);
  }

  async get(scope: ProjectRef, name: string): Promise<Dataset> {
    requireStorageName(name, "dataset");
    const result = await this.database.query<DatasetRow>(`
      SELECT * FROM datasets WHERE project_id = $1 AND name = $2
    `, [scope.projectId, name]);
    const row = result.rows[0];
    if (row === undefined) throw new DatasetNotFoundError();
    return dataset(row);
  }

  /** Creates the dataset on first use, then appends; returns the dataset after the write. */
  async append(scope: ProjectRef, name: string, items: readonly unknown[]): Promise<Dataset> {
    if (!Array.isArray(items) || items.length < 1 || items.length > maxDatasetItemsPerAppend) {
      throw new StorageInputError(`Append between 1 and ${maxDatasetItemsPerAppend} items at a time.`);
    }
    const encoded = items.map(itemJson);
    return this.database.transaction(async (transaction) => {
      const id = await ensureDataset(transaction, scope.projectId, name);
      return appendDatasetItems(transaction, scope.projectId, id, encoded);
    });
  }

  /** Reads items after `offset` (sequence numbers are 1-based and contiguous). */
  async listItems(
    scope: ProjectRef,
    name: string,
    input: Readonly<{ offset: number; limit: number }>,
  ): Promise<Readonly<{ dataset: Dataset; items: readonly DatasetItem[] }>> {
    requireLimit(input.limit, maxDatasetItemsPerRead);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new StorageInputError("offset must be a non-negative integer.");
    }
    return this.database.transaction(async (transaction) => {
      const found = await transaction.query<DatasetRow>(`
        SELECT * FROM datasets WHERE project_id = $1 AND name = $2
      `, [scope.projectId, name]);
      const row = found.rows[0];
      if (row === undefined) throw new DatasetNotFoundError();
      const result = await transaction.query<{ sequence: number | string; item: Record<string, unknown> }>(`
        SELECT sequence, item FROM dataset_items
        WHERE dataset_id = $1 AND project_id = $2 AND sequence > $3
        ORDER BY sequence LIMIT $4
      `, [row.id, scope.projectId, input.offset, input.limit]);
      return Object.freeze({
        dataset: dataset(row),
        items: result.rows.map((item) => Object.freeze({ sequence: Number(item.sequence), item: item.item })),
      });
    });
  }
}

export class KeyValueStoreService {
  readonly maxRecordBytes: number;

  constructor(
    private readonly database: ControlPlaneDatabase,
    options: Readonly<{ maxRecordBytes?: number }> = {},
  ) {
    this.maxRecordBytes = options.maxRecordBytes ?? defaultKeyValueRecordMaxBytes;
  }

  async listStores(
    scope: ProjectRef,
    input: Readonly<{ after: string | null; limit: number }>,
  ): Promise<readonly KeyValueStore[]> {
    requireLimit(input.limit, 101);
    const result = await this.database.query<{ id: string; name: string; created_at: Date }>(`
      SELECT id, name, created_at FROM key_value_stores
      WHERE project_id = $1 AND ($2::text IS NULL OR name > $2)
      ORDER BY name LIMIT $3
    `, [scope.projectId, input.after, input.limit]);
    return result.rows.map((row) => Object.freeze({ id: row.id, name: row.name, createdAt: row.created_at }));
  }

  async listKeys(
    scope: ProjectRef,
    store: string,
    input: Readonly<{ after: string | null; limit: number }>,
  ): Promise<readonly KeyValueRecordMetadata[]> {
    requireLimit(input.limit, 1_001);
    const storeId = await this.storeId(this.database, scope, store);
    const result = await this.database.query<RecordRow>(`
      SELECT key, content_type, byte_count, updated_at FROM key_value_records
      WHERE store_id = $1 AND project_id = $2 AND ($3::text IS NULL OR key > $3)
      ORDER BY key LIMIT $4
    `, [storeId, scope.projectId, input.after, input.limit]);
    return result.rows.map(recordMetadata);
  }

  async get(scope: ProjectRef, store: string, key: string): Promise<KeyValueRecord> {
    requireRecordKey(key);
    const storeId = await this.storeId(this.database, scope, store);
    const result = await this.database.query<RecordRow>(`
      SELECT key, content_type, byte_count, updated_at, value FROM key_value_records
      WHERE store_id = $1 AND project_id = $2 AND key = $3
    `, [storeId, scope.projectId, key]);
    const row = result.rows[0];
    if (row?.value === undefined) throw new KeyValueRecordNotFoundError();
    return Object.freeze({ ...recordMetadata(row), value: row.value });
  }

  /** Creates the store on first write and replaces any existing record under the key. */
  async put(
    scope: ProjectRef,
    store: string,
    key: string,
    record: Readonly<{ contentType: string; value: Buffer }>,
  ): Promise<KeyValueRecordMetadata> {
    requireStorageName(store, "store");
    requireRecordKey(key);
    const contentType = record.contentType.trim();
    if (contentType.length < 1 || contentType.length > 255) {
      throw new StorageInputError("The record content type must contain 1-255 characters.");
    }
    if (record.value.byteLength > this.maxRecordBytes) throw new KeyValueRecordTooLargeError(this.maxRecordBytes);
    return this.database.transaction(async (transaction) => {
      const created = await transaction.query<{ id: string }>(`
        INSERT INTO key_value_stores(id, project_id, name) VALUES ($1, $2, $3)
        ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [randomUUID(), scope.projectId, store]);
      const result = await transaction.query<RecordRow>(`
        INSERT INTO key_value_records(project_id, store_id, key, content_type, value, byte_count)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (store_id, key) DO UPDATE SET content_type = EXCLUDED.content_type,
          value = EXCLUDED.value, byte_count = EXCLUDED.byte_count, updated_at = clock_timestamp()
        RETURNING key, content_type, byte_count, updated_at
      `, [scope.projectId, created.rows[0]?.id, key, contentType, record.value, record.value.byteLength]);
      return recordMetadata(result.rows[0] as RecordRow);
    });
  }

  async delete(scope: ProjectRef, store: string, key: string): Promise<void> {
    requireRecordKey(key);
    const storeId = await this.storeId(this.database, scope, store);
    const result = await this.database.query<{ key: string }>(`
      DELETE FROM key_value_records WHERE store_id = $1 AND project_id = $2 AND key = $3
      RETURNING key
    `, [storeId, scope.projectId, key]);
    if (result.rows[0] === undefined) throw new KeyValueRecordNotFoundError();
  }

  private async storeId(database: ControlPlaneQuery, scope: ProjectRef, store: string): Promise<string> {
    requireStorageName(store, "store");
    const result = await database.query<{ id: string }>(`
      SELECT id FROM key_value_stores WHERE project_id = $1 AND name = $2
    `, [scope.projectId, store]);
    const id = result.rows[0]?.id;
    if (id === undefined) throw new KeyValueStoreNotFoundError();
    return id;
  }
}
