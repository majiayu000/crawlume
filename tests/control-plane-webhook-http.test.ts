import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedProjectApiKey } from "../src/control-plane/api-key-service.js";
import { ProjectJobHttpApi } from "../src/control-plane/project-http-api.js";
import type { WebhookHttpServices } from "../src/control-plane/webhook-http.js";
import {
  WebhookEndpointInvalidError,
  WebhookNotFoundError,
  WebhooksDisabledError,
  type WebhookEndpoint,
} from "../src/control-plane/webhooks.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const endpointId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const requestId = "11111111-1111-4111-8111-111111111111";
const rawKey = `dya_live_deadbeef_${"A".repeat(43)}`;
const createdAt = new Date("2026-10-22T00:00:00.000Z");

const endpoint: WebhookEndpoint = Object.freeze({
  id: endpointId,
  url: "https://hooks.example.com/crawlume",
  eventTypes: Object.freeze(["job.completed" as const]),
  status: "active" as const,
  createdAt,
});

function identity(scopes: AuthenticatedProjectApiKey["scopes"]): AuthenticatedProjectApiKey {
  return Object.freeze({
    apiKeyId: "key-a", projectId, organizationId: "organization-a", createdByUserId: "user-a", scopes,
  });
}

function harness(
  webhooks: Partial<WebhookHttpServices>,
  scopes: AuthenticatedProjectApiKey["scopes"] = ["project:admin"],
) {
  const unused = vi.fn(async () => {
    throw new Error("unexpected Job service call");
  });
  const services: WebhookHttpServices = {
    createEndpoint: vi.fn(async () => ({ endpoint, secret: "whsec_secret" })),
    listEndpoints: vi.fn(async () => [endpoint]),
    disableEndpoint: vi.fn(async () => undefined),
    rotateSecret: vi.fn(async () => "whsec_rotated"),
    redeliver: vi.fn(async () => 2),
    listDeliveries: vi.fn(async () => []),
    ...webhooks,
  };
  const api = new ProjectJobHttpApi({
    authenticate: vi.fn(async () => identity(scopes)),
    createJob: unused, getJob: unused, pauseJob: unused, resumeJob: unused, cancelJob: unused,
    listPublications: unused, listAuditEvents: unused,
    webhooks: services,
  }, { requestId: () => requestId });
  return { api, services };
}

function request(method: string, path: string, body?: unknown, query = "") {
  return {
    method,
    path: `/v1/projects/${projectId}${path}`,
    query,
    headers: { authorization: `Bearer ${rawKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body,
  };
}

describe("Project webhook HTTP API", () => {
  it("creates an endpoint and returns its secret once", async () => {
    const { api, services } = harness({});
    const response = await api.handle(request("POST", "/webhook-endpoints", {
      url: "https://hooks.example.com/crawlume",
      event_types: ["job.completed"],
    }));
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      request_id: requestId,
      endpoint: {
        id: endpointId, url: "https://hooks.example.com/crawlume", event_types: ["job.completed"],
        status: "active", created_at: createdAt.toISOString(),
      },
      secret: "whsec_secret",
    });
    expect(services.createEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ projectId }),
      { url: "https://hooks.example.com/crawlume", eventTypes: ["job.completed"] },
    );
  });

  it("lists endpoints, disables, rotates, and redelivers", async () => {
    const { api } = harness({});
    expect((await api.handle(request("GET", "/webhook-endpoints"))).status).toBe(200);
    const disabled = await api.handle(request("DELETE", `/webhook-endpoints/${endpointId}`));
    expect(disabled).toMatchObject({ status: 204, body: null });
    expect((await api.handle(request("POST", `/webhook-endpoints/${endpointId}/rotate-secret`, {}))).body)
      .toEqual({ request_id: requestId, secret: "whsec_rotated" });
    expect(await api.handle(request("POST", `/webhook-events/${eventId}/redeliver`, {})))
      .toMatchObject({ status: 202, body: { queued: 2 } });
    expect((await api.handle(request("GET", "/webhook-deliveries", undefined, "limit=10"))).status).toBe(200);
  });

  it("requires the project:admin scope", async () => {
    const { api, services } = harness({}, ["tasks:write"]);
    const response = await api.handle(request("GET", "/webhook-endpoints"));
    expect(response.status).toBe(403);
    expect(services.listEndpoints).not.toHaveBeenCalled();
  });

  it("answers 405 with Allow for an unsupported method on a known path", async () => {
    const { api } = harness({});
    const response = await api.handle(request("PUT", "/webhook-endpoints"));
    expect(response.status).toBe(405);
    expect(response.headers).toMatchObject({ allow: "POST, GET" });
  });

  it.each([
    [new WebhooksDisabledError(), 503, "WEBHOOKS_DISABLED"],
    [new WebhookEndpointInvalidError("Webhook URLs must use https."), 422, "WEBHOOK_ENDPOINT_INVALID"],
    [new WebhookNotFoundError("endpoint"), 404, "WEBHOOK_NOT_FOUND"],
  ])("maps %s to an explicit problem", async (error, status, code) => {
    const { api } = harness({ createEndpoint: vi.fn(async () => { throw error; }) });
    const response = await api.handle(request("POST", "/webhook-endpoints", {
      url: "http://hooks.example.com",
      event_types: ["job.completed"],
    }));
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code });
  });

  it("rejects unknown event types and invalid delivery queries", async () => {
    const { api } = harness({});
    expect((await api.handle(request("POST", "/webhook-endpoints", {
      url: "https://hooks.example.com", event_types: ["job.started"],
    }))).status).toBe(422);
    expect((await api.handle(request("GET", "/webhook-deliveries", undefined, "limit=500"))).status).toBe(400);
  });
});
