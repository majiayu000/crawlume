import { z } from "zod";

import { requireProjectApiKeyScope, type AuthenticatedProjectApiKey } from "./api-key-service.js";
import type { WorkerHttpRequest } from "./organization-service.js";
import {
  maxDatasetItemsPerAppend,
  maxDatasetItemsPerRead,
  type Dataset,
  type DatasetService,
  type KeyValueRecordMetadata,
  type KeyValueStoreService,
} from "./project-storage.js";
import { storageRouteDefinitions } from "./router-contract.js";

export type StorageHttpServices = Readonly<{
  datasets: Pick<DatasetService, "list" | "get" | "append" | "listItems">;
  keyValueStores: Pick<KeyValueStoreService, "listStores" | "listKeys" | "get" | "put" | "delete">;
}>;

type RouteDefinition = Readonly<{ kind: string; method: string; pattern: RegExp }>;

export type ProjectSubRoute<Kind extends string> = Readonly<{
  kind: Kind;
  projectId: string;
  parameters: readonly string[];
}>;

export type ProjectSubRouteMatch<Kind extends string> =
  | Readonly<{ route: ProjectSubRoute<Kind> }>
  | Readonly<{ allow: string; projectId: string }>;

/** A raw body (Buffer) is sent as-is with its own content-type; anything else is JSON. */
export type ProjectSubRouteResult = Readonly<{
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

export class StorageQueryError extends Error {
  readonly code = "PROJECT_QUERY_INVALID";
  constructor() {
    super("The query parameters are invalid or unsupported.");
    this.name = "StorageQueryError";
  }
}

/** Matches a Project sub-API path; a known path with another method yields its Allow header value. */
export function matchProjectSubRoute<Definition extends RouteDefinition>(
  definitions: readonly Definition[],
  path: string,
  method: string,
): ProjectSubRouteMatch<Definition["kind"]> | null {
  const allowed: string[] = [];
  let projectId: string | null = null;
  for (const definition of definitions) {
    const matched = definition.pattern.exec(path);
    if (matched?.[1] === undefined) continue;
    projectId = matched[1];
    if (definition.method !== method.toUpperCase()) {
      allowed.push(definition.method);
      continue;
    }
    return { route: { kind: definition.kind, projectId, parameters: matched.slice(2) as string[] } };
  }
  return projectId === null ? null : { allow: allowed.join(", "), projectId };
}

export function matchStorageRoute(path: string, method: string) {
  return matchProjectSubRoute(storageRouteDefinitions, path, method);
}

/** Parses an allow-listed query where each parameter appears at most once. */
export function singleQueryValues(
  query: string,
  allowed: readonly string[],
): ReadonlyMap<string, string> {
  const parameters = new URLSearchParams(query);
  const values = new Map<string, string>();
  for (const [key, value] of parameters) {
    if (!allowed.includes(key) || values.has(key)) throw new StorageQueryError();
    values.set(key, value);
  }
  return values;
}

function queryInteger(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = values.get(name);
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new StorageQueryError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new StorageQueryError();
  return parsed;
}

function nameCursor(values: ReadonlyMap<string, string>): string | null {
  const cursor = values.get("cursor");
  if (cursor === undefined) return null;
  if (cursor.length < 1 || cursor.length > 256) throw new StorageQueryError();
  return cursor;
}

function wireDataset(dataset: Dataset): Record<string, unknown> {
  return {
    id: dataset.id, name: dataset.name, item_count: dataset.itemCount,
    created_at: dataset.createdAt.toISOString(), updated_at: dataset.updatedAt.toISOString(),
  };
}

function wireRecord(record: KeyValueRecordMetadata): Record<string, unknown> {
  return {
    key: record.key, content_type: record.contentType, byte_count: record.byteCount,
    updated_at: record.updatedAt.toISOString(),
  };
}

function page<Item>(items: readonly Item[], limit: number, cursor: (item: Item) => string) {
  const hasMore = items.length > limit;
  const visible = items.slice(0, limit);
  return {
    visible,
    pagination: {
      next_cursor: hasMore && visible.length > 0 ? cursor(visible.at(-1) as Item) : null,
      has_more: hasMore,
      limit,
    },
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? ""
    : typeof value === "object" ? JSON.stringify(value)
    : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

/** RFC 4180 CSV: one column per top-level key (first-seen order), nested values as JSON. */
export function datasetItemsCsv(items: readonly Readonly<Record<string, unknown>>[]): string {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines = [columns.map(csvCell).join(",")];
  for (const item of items) lines.push(columns.map((column) => csvCell(item[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

const exportFormats = {
  json: { contentType: "application/json", encode: (items: readonly unknown[]) => JSON.stringify(items) },
  jsonl: {
    contentType: "application/x-ndjson",
    encode: (items: readonly unknown[]) => items.map((item) => `${JSON.stringify(item)}\n`).join(""),
  },
  csv: {
    contentType: "text/csv; charset=utf-8",
    encode: (items: readonly unknown[]) => datasetItemsCsv(items as Readonly<Record<string, unknown>>[]),
  },
} as const;

// Raw bodies are user content; never let a browser run them on the control-plane origin.
const rawContentSecurityPolicy = "sandbox; default-src 'none'";

const appendItemsSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).min(1).max(maxDatasetItemsPerAppend),
}).strict();

function requestContentType(request: WorkerHttpRequest): string {
  const found = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === "content-type");
  const value = found.length === 1 ? found[0]?.[1] : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "application/octet-stream";
}

/** Runs an authenticated storage route: reads need results:read, writes need tasks:write. */
export async function handleStorageRoute(
  services: StorageHttpServices,
  route: ProjectSubRoute<(typeof storageRouteDefinitions)[number]["kind"]>,
  identity: AuthenticatedProjectApiKey,
  request: WorkerHttpRequest,
): Promise<ProjectSubRouteResult> {
  const [name = "", key = ""] = route.parameters;
  const query = request.query ?? "";
  const write = route.kind === "append-items" || route.kind === "put-record" || route.kind === "delete-record";
  requireProjectApiKeyScope(identity, write ? "tasks:write" : "results:read");
  switch (route.kind) {
    case "list-datasets": {
      const values = singleQueryValues(query, ["cursor", "limit"]);
      const limit = queryInteger(values, "limit", 50, 1, 100);
      const found = await services.datasets.list(identity, { after: nameCursor(values), limit: limit + 1 });
      const { visible, pagination } = page(found, limit, (dataset) => dataset.name);
      return { status: 200, body: { datasets: visible.map(wireDataset), pagination } };
    }
    case "get-dataset":
      singleQueryValues(query, []);
      return { status: 200, body: { dataset: wireDataset(await services.datasets.get(identity, name)) } };
    case "append-items": {
      singleQueryValues(query, []);
      const parsed = appendItemsSchema.parse(request.body);
      const dataset = await services.datasets.append(identity, name, parsed.items);
      return { status: 201, body: { dataset: wireDataset(dataset), appended: parsed.items.length } };
    }
    case "list-items": {
      const values = singleQueryValues(query, ["offset", "limit"]);
      const offset = queryInteger(values, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = queryInteger(values, "limit", 100, 1, 1_000);
      const found = await services.datasets.listItems(identity, name, { offset, limit });
      const nextOffset = offset + found.items.length;
      return {
        status: 200,
        body: {
          items: found.items.map(({ item }) => item),
          pagination: {
            offset, limit, total: found.dataset.itemCount, next_offset: nextOffset,
            has_more: nextOffset < found.dataset.itemCount,
          },
        },
      };
    }
    case "export-items": {
      const values = singleQueryValues(query, ["format", "offset", "limit"]);
      const format = values.get("format") ?? "json";
      if (!Object.hasOwn(exportFormats, format)) throw new StorageQueryError();
      const encoder = exportFormats[format as keyof typeof exportFormats];
      const offset = queryInteger(values, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = queryInteger(values, "limit", maxDatasetItemsPerRead, 1, maxDatasetItemsPerRead);
      const found = await services.datasets.listItems(identity, name, { offset, limit });
      return {
        status: 200,
        body: Buffer.from(encoder.encode(found.items.map(({ item }) => item))),
        headers: {
          "content-type": encoder.contentType,
          "content-disposition": `attachment; filename="${name}.${format}"`,
          "x-total-count": String(found.dataset.itemCount),
          "content-security-policy": rawContentSecurityPolicy,
        },
      };
    }
    case "list-stores": {
      const values = singleQueryValues(query, ["cursor", "limit"]);
      const limit = queryInteger(values, "limit", 50, 1, 100);
      const found = await services.keyValueStores.listStores(identity, { after: nameCursor(values), limit: limit + 1 });
      const { visible, pagination } = page(found, limit, (store) => store.name);
      return {
        status: 200,
        body: {
          key_value_stores: visible.map((store) => ({
            id: store.id, name: store.name, created_at: store.createdAt.toISOString(),
          })),
          pagination,
        },
      };
    }
    case "list-records": {
      const values = singleQueryValues(query, ["cursor", "limit"]);
      const limit = queryInteger(values, "limit", 100, 1, 1_000);
      const found = await services.keyValueStores.listKeys(identity, name, {
        after: nameCursor(values), limit: limit + 1,
      });
      const { visible, pagination } = page(found, limit, (record) => record.key);
      return { status: 200, body: { records: visible.map(wireRecord), pagination } };
    }
    case "get-record": {
      singleQueryValues(query, []);
      const record = await services.keyValueStores.get(identity, name, key);
      return {
        status: 200,
        body: record.value,
        headers: {
          "content-type": record.contentType,
          "last-modified": record.updatedAt.toUTCString(),
          "content-security-policy": rawContentSecurityPolicy,
        },
      };
    }
    case "put-record": {
      singleQueryValues(query, []);
      const value = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const record = await services.keyValueStores.put(identity, name, key, {
        contentType: requestContentType(request), value,
      });
      return { status: 200, body: { record: wireRecord(record) } };
    }
    case "delete-record":
      singleQueryValues(query, []);
      await services.keyValueStores.delete(identity, name, key);
      return { status: 204, body: null };
  }
}
