import { describe, expect, it } from "vitest";

import { ControlPlaneError, CrawlumeClient } from "../src/sdk/client.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const base = `https://control.example/v1/projects/${projectId}`;

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function client(responses: Array<() => Response>): { sdk: CrawlumeClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url), method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>, body: init?.body,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    return next();
  }) as typeof fetch;
  return {
    sdk: new CrawlumeClient({
      baseUrl: "https://control.example/v1/", apiKey: "dya_live_test", projectId, fetch: fetchImpl, retryBaseMs: 0,
    }),
    calls,
  };
}

const unavailable = () => new Response(JSON.stringify({ code: "INTERNAL_ERROR", status: 500, retryable: true }), {
  status: 500, headers: { "content-type": "application/problem+json" },
});

describe("SDK storage and schedules", () => {
  it("does not retry dataset appends, which would duplicate items", async () => {
    const { sdk, calls } = client([unavailable, unavailable]);
    await expect(sdk.appendDatasetItems("results", [{ a: 1 }])).rejects.toBeInstanceOf(ControlPlaneError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${base}/datasets/results/items`, method: "POST", body: JSON.stringify({ items: [{ a: 1 }] }),
    });
  });

  it("pages dataset items by offset and exports text", async () => {
    const page = (items: unknown[], offset: number, hasMore: boolean) => () => Response.json({
      items, pagination: { offset, limit: 1, total: 2, next_offset: offset + items.length, has_more: hasMore },
    });
    const { sdk, calls } = client([
      page([{ n: 1 }], 0, true), page([{ n: 2 }], 1, false), () => new Response("n\r\n1\r\n2\r\n"),
    ]);
    const items = [];
    for await (const item of sdk.datasetItems("results", { limit: 1 })) items.push(item);
    expect(items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await sdk.exportDataset("results", { format: "csv" })).toBe("n\r\n1\r\n2\r\n");
    expect(calls.map(({ url }) => url)).toEqual([
      `${base}/datasets/results/items?limit=1&offset=0`,
      `${base}/datasets/results/items?limit=1&offset=1`,
      `${base}/datasets/results/export?format=csv`,
    ]);
  });

  it("puts raw record bytes with their content type and reads them back", async () => {
    const record = { key: "INPUT", content_type: "image/png", byte_count: 3, updated_at: "2030-01-01T00:00:00.000Z" };
    const { sdk, calls } = client([
      () => Response.json({ record }),
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      () => new Response(null, { status: 204 }),
    ]);
    expect(await sdk.putKeyValueRecord("state", "INPUT", new Uint8Array([1, 2, 3]), "image/png")).toEqual(record);
    expect(calls[0]).toMatchObject({ method: "PUT", headers: { "content-type": "image/png" } });
    expect(await sdk.getKeyValueRecord("state", "INPUT")).toEqual({
      contentType: "image/png", value: new Uint8Array([1, 2, 3]),
    });
    await expect(sdk.deleteKeyValueRecord("state", "INPUT")).resolves.toBeUndefined();
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `PUT ${base}/key-value-stores/state/records/INPUT`,
      `GET ${base}/key-value-stores/state/records/INPUT`,
      `DELETE ${base}/key-value-stores/state/records/INPUT`,
    ]);
  });

  it("creates and toggles schedules", async () => {
    const schedule = { id: "33333333-3333-4333-8333-333333333333", name: "nightly", enabled: false };
    const { sdk, calls } = client([() => Response.json({ schedule }, { status: 201 }), () => Response.json({ schedule })]);
    const job = {
      type: "read", input: { url: "https://example.com" }, data_class: "public",
      placement: { class: "public", pinned_worker_id: null }, required_capabilities: { http: true },
      budget: { deadline_ms: 1, max_provider_attempts: 1, max_document_bytes: 1, max_browser_ms: 0, max_browser_contexts: 0 },
      policy_version: "v1", upload_private_artifact: false, dataset: "results",
    } as const;
    await sdk.createSchedule({ name: "nightly", cron: "0 3 * * *", job });
    await sdk.disableSchedule(schedule.id);
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${base}/schedules`, `POST ${base}/schedules/${schedule.id}/disable`,
    ]);
  });
});
