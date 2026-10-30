import { describe, expect, it, vi } from "vitest";

import { withHealthChecks } from "../src/control-plane/health.js";

function harness(query: () => Promise<{ rows: unknown[] }>, timeoutMs?: number) {
  const database = { query: vi.fn(query) };
  const downstream = { status: 404, headers: {}, body: { code: "WORKER_ROUTE_NOT_FOUND" } };
  const handle = vi.fn(async () => downstream);
  return { api: withHealthChecks({ handle }, database, timeoutMs), database, handle, downstream };
}

function request(path: string, method = "GET") {
  return { method, path, headers: {}, body: null };
}

describe("control-plane health checks", () => {
  it("reports liveness without touching the database", async () => {
    const { api, database, handle } = harness(async () => ({ rows: [] }));

    await expect(api.handle(request("/healthz"))).resolves.toMatchObject({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { status: "ok" },
    });
    expect(database.query).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("reports readiness after the database answers", async () => {
    const { api, database } = harness(async () => ({ rows: [] }));

    await expect(api.handle(request("/readyz"))).resolves.toMatchObject({
      status: 200,
      body: { status: "ready" },
    });
    expect(database.query).toHaveBeenCalledWith("SELECT 1");
  });

  it("fails readiness without exposing the database error", async () => {
    const { api } = harness(async () => {
      throw new Error("password authentication failed for postgres://secret@db");
    });

    const response = await api.handle(request("/readyz"));

    expect(response).toMatchObject({ status: 503, body: { status: "unavailable" } });
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  it("fails readiness when the database does not answer in time", async () => {
    const { api } = harness(() => new Promise(() => undefined), 5);

    await expect(api.handle(request("/readyz"))).resolves.toMatchObject({ status: 503 });
  });

  it.each(["/healthz", "/readyz"])("allows only GET on %s", async (path) => {
    const { api, handle } = harness(async () => ({ rows: [] }));

    await expect(api.handle(request(path, "POST"))).resolves.toMatchObject({
      status: 405,
      headers: { allow: "GET" },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("forwards every other path to the API", async () => {
    const { api, downstream } = harness(async () => ({ rows: [] }));

    await expect(api.handle(request("/v1/healthz"))).resolves.toBe(downstream);
  });
});
