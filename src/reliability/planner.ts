import { createHash } from "node:crypto";

import { ReadError } from "../errors.js";
import type {
  AccessPlan,
  BrowserReadinessPolicy,
  ExecutionBudget,
  PlannedStage,
  PlannedStageInput,
  PlannedStageReasonCode,
  PlanningFacts,
  ReadCompletion,
  ReadIntent,
  StagePredicate,
} from "../types.js";

export const accessPlannerVersion = "access-planner-v1";

const operations = new Set<ReadIntent["operation"]>([
  "read", "inspect", "map", "crawl", "extract",
]);
const cachePolicies = new Set<PlanningFacts["cachePolicy"]>([
  "prefer-cache", "live", "cache-only",
]);

function invalid(message: string, reason: string): never {
  throw new ReadError("INVALID_ARGUMENT", message, { details: { reason } });
}

function requireSafeInteger(
  value: number,
  name: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid(`${name} must be a safe integer greater than or equal to ${minimum}.`, name);
  }
  return value;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid("authorization.allowedOrigins must contain valid HTTP or HTTPS origins.", "allowed-origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    invalid("authorization.allowedOrigins must contain valid HTTP or HTTPS origins.", "allowed-origin");
  }
  return parsed.origin;
}

function normalizeUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid("ReadIntent.url must be a valid HTTP or HTTPS URL.", "url");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    invalid("ReadIntent.url must be a valid HTTP or HTTPS URL without credentials.", "url");
  }
  return parsed;
}

function normalizeReadiness(policy: BrowserReadinessPolicy): BrowserReadinessPolicy {
  const selector = policy.target.selector.trim();
  if (selector.length === 0) {
    invalid("DOM completion requires a non-empty target selector.", "completion-selector");
  }
  const state = policy.target.state ?? "attached";
  if (state !== "attached" && state !== "visible") {
    invalid("DOM completion target state must be attached or visible.", "completion-state");
  }
  const minCount = requireSafeInteger(policy.target.minCount ?? 1, "completion.minCount", 1);
  const timeoutMs = policy.timeoutMs === undefined
    ? undefined
    : requireSafeInteger(policy.timeoutMs, "completion.timeoutMs", 1);
  const interaction = policy.interaction;
  if (interaction !== undefined && interaction.type !== "scroll-to-end") {
    invalid("The requested DOM interaction is not supported.", "completion-interaction");
  }
  const normalizedInteraction = interaction === undefined
    ? undefined
    : {
        type: "scroll-to-end" as const,
        maxSteps: requireSafeInteger(interaction.maxSteps, "completion.maxSteps", 1),
        stepDelayMs: requireSafeInteger(
          interaction.stepDelayMs ?? 100,
          "completion.stepDelayMs",
          0,
        ),
      };
  return {
    target: { selector, state, minCount },
    ...(normalizedInteraction === undefined ? {} : { interaction: normalizedInteraction }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function normalizeCompletion(completion: ReadCompletion): ReadCompletion {
  if (completion.type === "content") return { type: "content" };
  if (completion.type === "discovery") return { type: "discovery" };
  if (completion.type === "dom") {
    return { type: "dom", readiness: normalizeReadiness(completion.readiness) };
  }
  return invalid("ReadIntent.completion is not supported.", "completion");
}

function normalizeBudget(budget: ExecutionBudget): ExecutionBudget {
  return {
    deadlineMs: requireSafeInteger(budget.deadlineMs, "budget.deadlineMs", 1),
    maxAttempts: requireSafeInteger(budget.maxAttempts, "budget.maxAttempts", 1),
    maxDocumentBytes: requireSafeInteger(budget.maxDocumentBytes, "budget.maxDocumentBytes", 0),
    maxBrowserMs: requireSafeInteger(budget.maxBrowserMs, "budget.maxBrowserMs", 0),
    maxBrowserContexts: requireSafeInteger(
      budget.maxBrowserContexts,
      "budget.maxBrowserContexts",
      0,
    ),
    maxOptionalModelTokens: requireSafeInteger(
      budget.maxOptionalModelTokens,
      "budget.maxOptionalModelTokens",
      0,
    ),
  };
}

function normalizeIntent(intent: ReadIntent): ReadIntent {
  const url = normalizeUrl(intent.url);
  if (!operations.has(intent.operation)) {
    invalid("ReadIntent.operation is not supported.", "operation");
  }
  if (intent.output.format !== "markdown" && intent.output.format !== "json") {
    invalid("ReadIntent.output.format is not supported.", "output-format");
  }
  if (
    intent.output.schemaId !== undefined &&
    intent.output.schemaId.trim().length === 0
  ) {
    invalid("ReadIntent.output.schemaId must be non-empty when provided.", "schema-id");
  }
  requireSafeInteger(intent.freshness.maxAgeSeconds, "freshness.maxAgeSeconds", 0);
  if (typeof intent.freshness.allowStaleWhileRevalidate !== "boolean") {
    invalid("freshness.allowStaleWhileRevalidate must be boolean.", "freshness-swr");
  }
  const profileId = intent.authorization.profileId;
  if (profileId !== null && profileId.trim().length === 0) {
    invalid("authorization.profileId must be non-empty when provided.", "profile-id");
  }
  if (!Array.isArray(intent.authorization.allowedOrigins)) {
    invalid("authorization.allowedOrigins must be an array.", "allowed-origins");
  }
  const allowedOrigins = [...new Set(intent.authorization.allowedOrigins.map(normalizeOrigin))]
    .sort((left, right) => left.localeCompare(right));
  if (profileId !== null && !allowedOrigins.includes(url.origin)) {
    invalid("The authorized target origin is not included in allowedOrigins.", "authorization-origin");
  }
  return {
    url: url.toString(),
    operation: intent.operation,
    output: {
      format: intent.output.format,
      ...(intent.output.schemaId === undefined ? {} : { schemaId: intent.output.schemaId }),
    },
    freshness: {
      maxAgeSeconds: intent.freshness.maxAgeSeconds,
      allowStaleWhileRevalidate: intent.freshness.allowStaleWhileRevalidate,
    },
    authorization: { profileId, allowedOrigins },
    completion: normalizeCompletion(intent.completion),
    budget: normalizeBudget(intent.budget),
  };
}

function normalizeFacts(facts: PlanningFacts): PlanningFacts {
  if (!cachePolicies.has(facts.cachePolicy)) {
    invalid("PlanningFacts.cachePolicy is not supported.", "cache-policy");
  }
  for (const [provider, available] of Object.entries(facts.providers)) {
    if (typeof available !== "boolean") {
      invalid(`PlanningFacts.providers.${provider} must be boolean.`, "provider-availability");
    }
  }
  return {
    cachePolicy: facts.cachePolicy,
    providers: {
      cache: facts.providers.cache,
      http: facts.providers.http,
      browser: facts.providers.browser,
    },
  };
}

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

function planId(intent: ReadIntent, facts: PlanningFacts): string {
  const serialized = JSON.stringify(canonicalize({
    plannerVersion: accessPlannerVersion,
    intent,
    facts,
  }));
  return `plan_${createHash("sha256").update(serialized).digest("hex")}`;
}

function stageBudget(
  budget: ExecutionBudget,
  provider: PlannedStage["provider"],
  maxAttempts: number,
): ExecutionBudget {
  return {
    deadlineMs: budget.deadlineMs,
    maxAttempts,
    maxDocumentBytes: provider === "cache" ? 0 : budget.maxDocumentBytes,
    maxBrowserMs: provider === "browser" ? budget.maxBrowserMs : 0,
    maxBrowserContexts: provider === "browser" ? budget.maxBrowserContexts : 0,
    maxOptionalModelTokens: 0,
  };
}

function plannedStage(
  id: string,
  provider: PlannedStage["provider"],
  reasonCode: PlannedStageReasonCode,
  input: PlannedStageInput,
  runWhen: StagePredicate,
  budget: ExecutionBudget,
  maxAttempts = 1,
): PlannedStage {
  const retryableErrorCodes = provider === "http"
    ? ["RATE_LIMITED", "UPSTREAM_ERROR", "FETCH_TIMEOUT"] as const
    : provider === "browser"
      ? ["UPSTREAM_ERROR", "FETCH_TIMEOUT", "BROWSER_POOL_EXHAUSTED"] as const
      : [];
  return {
    id,
    provider,
    reasonCode,
    input,
    runWhen,
    retryPolicy: { maxAttempts, retryableErrorCodes: [...retryableErrorCodes] },
    budgetSlice: stageBudget(budget, provider, maxAttempts),
  };
}

export function planAccess(rawIntent: ReadIntent, rawFacts: PlanningFacts): AccessPlan {
  const intent = normalizeIntent(rawIntent);
  const facts = normalizeFacts(rawFacts);
  const stages: PlannedStage[] = [];
  const input: PlannedStageInput = {
    url: intent.url,
    operation: intent.operation,
    authorizationProfileId: intent.authorization.profileId,
    completion: intent.completion,
  };

  if (facts.cachePolicy === "cache-only") {
    if (!facts.providers.cache) {
      invalid("A cache-only intent cannot be satisfied because cache is unavailable.", "cache-unavailable");
    }
    stages.push(plannedStage(
      "cache-read", "cache", "CACHE_ONLY", input, { type: "always" }, intent.budget,
    ));
    return {
      id: planId(intent, facts),
      plannerVersion: accessPlannerVersion,
      stages,
      terminalConditions: ["valid-artifact", "policy-stop", "budget-exhausted"],
    };
  }

  const browserRequired = intent.authorization.profileId !== null || intent.completion.type === "dom";
  const browserCapable = facts.providers.browser && intent.budget.maxBrowserMs > 0 &&
    intent.budget.maxBrowserContexts > 0 && intent.budget.maxDocumentBytes > 0;
  const httpCapable = facts.providers.http && intent.budget.maxDocumentBytes > 0;
  if (browserRequired && !browserCapable) {
    invalid(
      "The intent requires browser execution, but the provider or browser budget is unavailable.",
      "browser-required",
    );
  }
  if (!browserRequired && !httpCapable && !browserCapable) {
    invalid("The live intent has no available network provider within budget.", "network-unavailable");
  }

  const includeCache = facts.cachePolicy === "prefer-cache" && facts.providers.cache;
  if (includeCache) {
    stages.push(plannedStage(
      "cache-read", "cache", "CACHE_PREFERRED", input, { type: "always" }, intent.budget,
    ));
  }
  const afterCache: StagePredicate = includeCache
    ? { type: "after-failure", stageId: "cache-read", errorCodes: ["CACHE_MISS"] }
    : { type: "always" };

  if (browserRequired) {
    const reason = intent.authorization.profileId === null
      ? "BROWSER_REQUIRED_BY_COMPLETION"
      : "BROWSER_REQUIRED_BY_AUTHORIZATION";
    stages.push(plannedStage(
      "browser-read",
      "browser",
      reason,
      input,
      afterCache,
      intent.budget,
      intent.budget.maxAttempts,
    ));
  } else if (httpCapable) {
    const browserFallback = browserCapable && intent.budget.maxAttempts >= 2;
    stages.push(plannedStage(
      "http-read",
      "http",
      "HTTP_PRIMARY",
      input,
      afterCache,
      intent.budget,
      intent.budget.maxAttempts,
    ));
    if (browserFallback) {
      stages.push(plannedStage(
        "browser-read",
        "browser",
        "BROWSER_AFTER_INCOMPLETE_HTTP",
        input,
        {
          type: "after-failure",
          stageId: "http-read",
          errorCodes: ["SHELL_ONLY", "INCOMPLETE_CONTENT"],
        },
        intent.budget,
        intent.budget.maxAttempts - 1,
      ));
    }
  } else {
    stages.push(plannedStage(
      "browser-read",
      "browser",
      "BROWSER_PRIMARY_HTTP_UNAVAILABLE",
      input,
      afterCache,
      intent.budget,
      intent.budget.maxAttempts,
    ));
  }

  const largestConditionalStageBudget = stages
    .filter(({ provider }) => provider !== "cache")
    .reduce((largest, stage) => Math.max(largest, stage.retryPolicy.maxAttempts), 0);
  if (largestConditionalStageBudget > intent.budget.maxAttempts) {
    invalid("The access plan would exceed budget.maxAttempts.", "attempt-budget");
  }
  return {
    id: planId(intent, facts),
    plannerVersion: accessPlannerVersion,
    stages,
    terminalConditions: ["valid-artifact", "policy-stop", "budget-exhausted"],
  };
}
