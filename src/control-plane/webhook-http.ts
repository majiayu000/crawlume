import { z } from "zod";

import { requireProjectApiKeyScope, type AuthenticatedProjectApiKey } from "./api-key-service.js";
import type { WorkerHttpRequest } from "./organization-service.js";
import { webhookRouteDefinitions } from "./router-contract.js";
import {
  webhookEventTypes,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookService,
} from "./webhooks.js";

export type WebhookRouteKind = (typeof webhookRouteDefinitions)[number]["kind"];

export type WebhookRoute = Readonly<{
  kind: WebhookRouteKind;
  projectId: string;
  resourceId: string | null;
}>;

export type WebhookRouteMatch =
  | Readonly<{ route: WebhookRoute }>
  | Readonly<{ allow: string; projectId: string }>;

export type WebhookHttpServices = Pick<
  WebhookService,
  "createEndpoint" | "listEndpoints" | "disableEndpoint" | "rotateSecret" | "redeliver" | "listDeliveries"
>;

export class WebhookQueryError extends Error {
  readonly code = "PROJECT_QUERY_INVALID";
  constructor() {
    super("The webhook query parameters are invalid or unsupported.");
    this.name = "WebhookQueryError";
  }
}

const createEndpointSchema = z.object({
  url: z.string().min(1).max(2_048),
  event_types: z.array(z.enum(webhookEventTypes)).min(1).max(webhookEventTypes.length),
}).strict();
const emptyBodySchema = z.object({}).strict();

/** Matches webhook paths; a known path with another method yields its Allow header value. */
export function matchWebhookRoute(path: string, method: string): WebhookRouteMatch | null {
  const allowed: string[] = [];
  let projectId: string | null = null;
  for (const definition of webhookRouteDefinitions) {
    const matched = definition.pattern.exec(path);
    if (matched?.[1] === undefined) continue;
    projectId = matched[1];
    if (definition.method !== method.toUpperCase()) {
      allowed.push(definition.method);
      continue;
    }
    return { route: { kind: definition.kind, projectId: matched[1], resourceId: matched[2] ?? null } };
  }
  return projectId === null ? null : { allow: allowed.join(", "), projectId };
}

function wireEndpoint(endpoint: WebhookEndpoint): Record<string, unknown> {
  return {
    id: endpoint.id, url: endpoint.url, event_types: endpoint.eventTypes,
    status: endpoint.status, created_at: endpoint.createdAt.toISOString(),
  };
}

function wireDelivery(delivery: WebhookDelivery): Record<string, unknown> {
  return {
    id: delivery.id, event_id: delivery.eventId, endpoint_id: delivery.endpointId,
    event_type: delivery.eventType, status: delivery.status, attempt_count: delivery.attemptCount,
    next_attempt_at: delivery.nextAttemptAt.toISOString(), last_status_code: delivery.lastStatusCode,
    last_error: delivery.lastError, created_at: delivery.createdAt.toISOString(),
  };
}

function deliveriesLimit(query: string): number {
  const parameters = new URLSearchParams(query);
  for (const key of parameters.keys()) if (key !== "limit") throw new WebhookQueryError();
  const values = parameters.getAll("limit");
  if (values.length === 0) return 50;
  const limit = Number(values[0]);
  if (values.length !== 1 || !/^[1-9][0-9]*$/u.test(values[0] ?? "") || limit > 100) {
    throw new WebhookQueryError();
  }
  return limit;
}

/** Runs an authenticated webhook route; every route requires the project:admin scope. */
export async function handleWebhookRoute(
  services: WebhookHttpServices,
  route: WebhookRoute,
  identity: AuthenticatedProjectApiKey,
  request: WorkerHttpRequest,
): Promise<Readonly<{ status: number; body: unknown }>> {
  requireProjectApiKeyScope(identity, "project:admin");
  if (route.kind !== "list-deliveries" && (request.query ?? "") !== "") throw new WebhookQueryError();
  switch (route.kind) {
    case "create-endpoint": {
      const parsed = createEndpointSchema.parse(request.body);
      const created = await services.createEndpoint(identity, { url: parsed.url, eventTypes: parsed.event_types });
      return { status: 201, body: { endpoint: wireEndpoint(created.endpoint), secret: created.secret } };
    }
    case "list-endpoints":
      return { status: 200, body: { endpoints: (await services.listEndpoints(identity)).map(wireEndpoint) } };
    case "disable-endpoint":
      await services.disableEndpoint(identity, route.resourceId as string);
      return { status: 204, body: null };
    case "rotate-secret":
      emptyBodySchema.parse(request.body);
      return { status: 200, body: { secret: await services.rotateSecret(identity, route.resourceId as string) } };
    case "redeliver-event":
      emptyBodySchema.parse(request.body);
      return { status: 202, body: { queued: await services.redeliver(identity, route.resourceId as string) } };
    case "list-deliveries": {
      const limit = deliveriesLimit(request.query ?? "");
      return { status: 200, body: { deliveries: (await services.listDeliveries(identity, limit)).map(wireDelivery) } };
    }
  }
}
