import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { ReadError } from "../errors.js";
import {
  normalizeBrowserReadinessPolicy,
  type NormalizedBrowserReadinessPolicy,
} from "../runtime/readiness.js";
import type {
  AccessPlan,
  CacheMode,
  ExecutionBudget,
  PlanningFacts,
  ReadIntent,
  ReadPageOptions,
} from "../types.js";
import { planAccess } from "./planner.js";

export type ReadOperation = Extract<ReadIntent["operation"], "read" | "map" | "crawl">;

export type NormalizedReadRequest = {
  requestId: string;
  cacheMode: CacheMode;
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
  browserAllowed: boolean;
  authProfile: string | null;
  browserReadiness?: NormalizedBrowserReadinessPolicy;
  budget: ExecutionBudget;
  intent: ReadIntent;
  facts: PlanningFacts;
  plan: AccessPlan;
};

function defaultExecutionBudget(config: AppConfig, browserAllowed: boolean): ExecutionBudget {
  const maxAttempts = config.crawlMaxAttempts;
  return {
    deadlineMs: config.requestTimeoutMs + (browserAllowed ? config.browserTimeoutMs : 0),
    maxAttempts,
    maxDocumentBytes: config.maxResponseBytes * maxAttempts,
    maxBrowserMs: browserAllowed ? config.browserTimeoutMs : 0,
    maxBrowserContexts: browserAllowed ? 1 : 0,
    maxOptionalModelTokens: 0,
  };
}

export function normalizeReadRequest(
  config: AppConfig,
  url: URL,
  options: ReadPageOptions,
  operation: ReadOperation,
): NormalizedReadRequest {
  const cacheMode = options.cacheMode ?? "prefer-cache";
  const maxAgeSeconds = options.maxAgeSeconds ?? config.defaultCacheSeconds;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new ReadError("INVALID_ARGUMENT", "maxAgeSeconds must be a positive integer.");
  }
  const staleWhileRevalidateSeconds = options.staleWhileRevalidateSeconds ?? 0;
  if (!Number.isSafeInteger(staleWhileRevalidateSeconds) || staleWhileRevalidateSeconds < 0) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      "staleWhileRevalidateSeconds must be a non-negative integer.",
    );
  }
  const browserAllowed = options.browserAllowed ?? true;
  if (!browserAllowed && options.authProfile !== undefined) {
    throw new ReadError("INVALID_ARGUMENT", "authProfile requires browser access.");
  }
  if (!browserAllowed && options.browserReadiness !== undefined) {
    throw new ReadError("INVALID_ARGUMENT", "browserReadiness requires browser access.");
  }
  const browserReadiness = options.browserReadiness === undefined
    ? undefined
    : normalizeBrowserReadinessPolicy(options.browserReadiness);
  const requestId = options.requestId ?? randomUUID();
  if (requestId.trim().length === 0) {
    throw new ReadError("INVALID_ARGUMENT", "requestId must be non-empty when provided.");
  }
  const authProfile = options.authProfile ?? null;
  const budget = options.budget ?? defaultExecutionBudget(config, browserAllowed);
  const intent: ReadIntent = {
    url: url.toString(),
    operation,
    output: { format: "markdown" },
    freshness: {
      maxAgeSeconds,
      allowStaleWhileRevalidate: staleWhileRevalidateSeconds > 0,
      ...(staleWhileRevalidateSeconds === 0 ? {} : { staleWhileRevalidateSeconds }),
    },
    authorization: {
      profileId: authProfile,
      allowedOrigins: [url.origin],
    },
    completion: browserReadiness === undefined
      ? operation === "map"
        ? { type: "discovery" }
        : { type: "content" }
      : { type: "dom", readiness: browserReadiness },
    budget,
  };
  const facts: PlanningFacts = {
    cachePolicy: cacheMode,
    providers: { cache: true, http: true, browser: browserAllowed },
  };
  return {
    requestId,
    cacheMode,
    maxAgeSeconds,
    staleWhileRevalidateSeconds,
    browserAllowed,
    authProfile,
    ...(browserReadiness === undefined ? {} : { browserReadiness }),
    budget,
    intent,
    facts,
    plan: planAccess(intent, facts),
  };
}
