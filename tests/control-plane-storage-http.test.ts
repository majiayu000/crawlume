import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedProjectApiKey } from "../src/control-plane/api-key-service.js";
import { startWorkerControlServer, type WorkerControlListener } from "../src/control-plane/http-listener.js";
import type { WorkerHttpRequest } from "../src/control-plane/organization-service.js";
import { ProjectJobHttpApi } from "../src/control-plane/project-http-api.js";
import { DatasetNotFoundError, type Dataset } from "../src/control-plane/project-storage.js";
import { datasetItemsCsv, type StorageHttpServices } from "../src/control-plane/storage-http.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2030-01-01T00:00:00.000Z");
const dataset: Dataset = { id: "33333333-3333-4333-8333-333333333333", name: "results", itemCount: 2, createdAt: now, updatedAt: now };
const items = [
  { url: "https://a.example", title: "A, \"quoted\"", tags: ["x"] },
  { url: "https://b.example", status: 200 },
];

function identity(scopes: AuthenticatedProjectApiKey["scopes"]): AuthenticatedProjectApiKey {
  return { apiKeyId: "key", projectId, organizationId: "organization", createdByUserId: "user", scopes };
}

function harness(scopes: AuthenticatedProjectApiKey["scopes"] = ["tasks:write", "results:read"]) {
  const storage = {
    datasets: {
      list: vi.fn(async () => [dataset]),
      get: vi.fn(async () => dataset),
      append: vi.fn(async () => dataset),
      listItems: vi.fn(async (_scope: unknown, _name: string, input: { offset: number }) => ({
        dataset,
        items: items.slice(input.offset).map((item, index) => ({ sequence: input.offset + index + 1, item })),
      })),
    },
    keyValueStores: {
      listStores: vi.fn(async () => []),
      listKeys: vi.fn(async () => []),
      get: vi.fn(async () => ({
        key: "INPUT", contentType: "image/png", byteCount: 3, updatedAt: now, value: Buffer.from([1, 2, 3]),
      })),
      put: vi.fn(async (_scope: unknown, _store: string, key: string, record: { contentType: string; value: Buffer }) => ({
        key, contentType: record.contentType, byteCount: record.value.byteLength, updatedAt: now,
      })),
      delete: vi.fn(async () => undefined),
    },
  } satisfies StorageHttpServices;
  const api = new ProjectJobHttpApi({
    authenticate: vi.fn(async () => identity(scopes)),
    createJob: vi.fn(), getJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), cancelJob: vi.fn(),
    listPublications: vi.fn(), listAuditEvents: vi.fn(),
    storage,
  });
  return { api, storage };
}

function request(overrides: Partial<WorkerHttpRequest>): WorkerHttpRequest {
  return {
    method: "GET",
    path: `/v1/projects/${projectId}/datasets/results/export`,
    query: "",
    headers: { authorization: "Bearer dya_live_test" },
    body: null,
    ...overrides,
  };
}

describe("dataset export formats", () => {
  it("writes RFC 4180 CSV with a column per top-level key and JSON-encoded nested values", () => {
    expect(datasetItemsCsv(items)).toBe(
      "url,title,tags,status\r\n" +
      "https://a.example,\"A, \"\"quoted\"\"\",\"[\"\"x\"\"]\",\r\n" +
      "https://b.example,,,200\r\n",
    );
    expect(datasetItemsCsv([])).toBe("\r\n");
  });

  it("serves json, jsonl and csv attachments from the stored items", async () => {
    const { api } = harness();
    const exported = async (format: string) => api.handle(request({ query: `?format=${format}` }));

    const json = await exported("json");
    expect(json.headers).toMatchObject({ "content-type": "application/json", "x-total-count": "2" });
    expect(JSON.parse((json.body as Buffer).toString())).toEqual(items);

    const jsonl = await exported("jsonl");
    expect(jsonl.headers["content-type"]).toBe("application/x-ndjson");
    expect((jsonl.body as Buffer).toString().split("\n")).toEqual([
      JSON.stringify(items[0]), JSON.stringify(items[1]), "",
    ]);

    const csv = await exported("csv");
    expect(csv.headers).toMatchObject({
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"results.csv\"",
    });
    expect((csv.body as Buffer).toString()).toBe(datasetItemsCsv(items));

    expect(await exported("xml")).toMatchObject({ status: 400, body: { code: "PROJECT_QUERY_INVALID" } });
  });
});

describe("storage HTTP routes", () => {
  it("pages dataset items by offset and reports the total", async () => {
    const { api } = harness();
    const response = await api.handle(request({
      path: `/v1/projects/${projectId}/datasets/results/items`, query: "?offset=1&limit=1",
    }));
    expect(response).toMatchObject({
      status: 200,
      body: {
        items: [items[1]],
        pagination: { offset: 1, limit: 1, total: 2, next_offset: 2, has_more: false },
      },
    });
  });

  it("enforces API key scopes and the Project in the path", async () => {
    const reader = harness(["results:read"]);
    expect(await reader.api.handle(request({
      method: "POST", path: `/v1/projects/${projectId}/datasets/results/items`,
      headers: { authorization: "Bearer dya_live_test", "content-type": "application/json" },
      body: { items: [{ a: 1 }] },
    }))).toMatchObject({ status: 403, body: { code: "API_KEY_SCOPE_DENIED" } });
    expect(reader.storage.datasets.append).not.toHaveBeenCalled();

    const writer = harness(["tasks:write"]);
    expect(await writer.api.handle(request({ path: `/v1/projects/${projectId}/datasets/results` })))
      .toMatchObject({ status: 403, body: { code: "API_KEY_SCOPE_DENIED" } });

    const other = harness();
    expect(await other.api.handle(request({ path: `/v1/projects/${otherProjectId}/datasets/results` })))
      .toMatchObject({ status: 403, body: { code: "PROJECT_PATH_IDENTITY_MISMATCH" } });
    expect(other.storage.datasets.get).not.toHaveBeenCalled();
  });

  it("maps missing datasets and wrong methods to problems", async () => {
    const { api, storage } = harness();
    storage.datasets.get.mockRejectedValueOnce(new DatasetNotFoundError());
    expect(await api.handle(request({ path: `/v1/projects/${projectId}/datasets/missing` })))
      .toMatchObject({ status: 404, body: { code: "DATASET_NOT_FOUND" } });
    expect(await api.handle(request({ method: "PATCH", path: `/v1/projects/${projectId}/datasets/results/items` })))
      .toMatchObject({ status: 405, headers: { allow: "POST, GET" } });
  });
});

describe("key-value records over a real socket", () => {
  let listener: WorkerControlListener | undefined;

  afterEach(async () => {
    await listener?.close();
    listener = undefined;
  });

  it("stores raw request bytes with their content type and returns raw bytes", async () => {
    const { api, storage } = harness();
    listener = await startWorkerControlServer(api, { host: "127.0.0.1", port: 0, tls: null, maxRawBodyBytes: 8 });
    const url = `${listener.origin}/v1/projects/${projectId}/key-value-stores/state/records/INPUT`;
    const headers = { authorization: "Bearer dya_live_test" };

    const put = await fetch(url, {
      method: "PUT", headers: { ...headers, "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ record: { key: "INPUT", content_type: "image/png", byte_count: 3 } });
    expect(storage.keyValueStores.put.mock.calls[0]?.[3]).toEqual({
      contentType: "image/png", value: Buffer.from([1, 2, 3]),
    });

    const tooLarge = await fetch(url, { method: "PUT", headers, body: new Uint8Array(9) });
    expect(tooLarge.status).toBe(413);

    const got = await fetch(url, { headers });
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
