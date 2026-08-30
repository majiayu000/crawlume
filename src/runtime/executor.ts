import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { PageCache } from "../cache.js";
import { CrawlRequestPolicy } from "../crawl-policy.js";
import { extractPage } from "../extract.js";
import { normalizeError, ReadError } from "../errors.js";
import { AttemptLedger } from "../jobs.js";
import type {
  AccessPlan,
  BrowserReadinessPolicy,
  ExecutionBudget,
  PageReadArtifact,
  PageFetcher,
  PlannedStage,
  ResourceUsage,
} from "../types.js";
import { validateContent } from "../validation.js";

export type FetchTrace = {
  fetchAttempts: Record<"http" | "browser", number>;
  responseBytesByMethod: Record<"http" | "browser", number>;
  fetchDurationMsByMethod: Record<"http" | "browser", number>;
  executedStages: string[];
  pendingRetryDelayMs: number;
};

export type StageExecutionResult = {
  artifact: PageReadArtifact;
  trace: FetchTrace;
  totalRetryDelayMs: number;
};

export type StageExecutionInput = {
  url: URL;
  cacheKey: string;
  maxAgeSeconds: number;
  authProfile: string | null;
  browserReadiness?: BrowserReadinessPolicy;
  requestId: string;
  plan: AccessPlan;
  budget: ExecutionBudget;
  signal?: AbortSignal;
};

function emptyUsage(): ResourceUsage {
  return {
    documentBytesIn: 0,
    networkBytesOut: 0,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryDelayMilliseconds: 0,
    optionalModelTokens: 0,
  };
}

function emptyFetchTrace(): FetchTrace {
  return {
    fetchAttempts: { http: 0, browser: 0 },
    responseBytesByMethod: { http: 0, browser: 0 },
    fetchDurationMsByMethod: { http: 0, browser: 0 },
    executedStages: [],
    pendingRetryDelayMs: 0,
  };
}

function stageAllowed(stage: PlannedStage, failures: ReadonlyMap<string, ReadError>): boolean {
  if (stage.runWhen.type === "always") return true;
  const failure = failures.get(stage.runWhen.stageId);
  if (failure === undefined) return false;
  if (stage.runWhen.type === "after-invalid") {
    return failure.code === "SHELL_ONLY" || failure.code === "INCOMPLETE_CONTENT";
  }
  return stage.runWhen.errorCodes.includes(failure.code);
}

function budgetError(
  dimension: keyof ExecutionBudget,
  limit: number,
  actual: number,
): ReadError {
  return new ReadError(
    "BUDGET_EXHAUSTED",
    `The access plan exhausted its ${dimension} budget.`,
    { details: { budgetDimension: dimension, budgetLimit: limit, budgetActual: actual } },
  );
}

function errorWithFetchTrace(
  error: unknown,
  trace: FetchTrace,
  requestId: string,
  plan: AccessPlan,
): ReadError {
  const normalized = normalizeError(error);
  const providerAttempts = trace.fetchAttempts.http + trace.fetchAttempts.browser;
  const networkStages = trace.executedStages.filter((stageId) => stageId !== "cache-read").length;
  return new ReadError(normalized.code, normalized.message, {
    retryable: normalized.retryable,
    details: {
      ...normalized.details,
      requestId,
      planId: plan.id,
      plannerVersion: plan.plannerVersion,
      plannedStageCount: plan.stages.length,
      retryAttempts: Math.max(0, providerAttempts - networkStages),
      httpFetchAttempts: trace.fetchAttempts.http,
      browserFetchAttempts: trace.fetchAttempts.browser,
      httpResponseBytes: trace.responseBytesByMethod.http,
      browserResponseBytes: trace.responseBytesByMethod.browser,
      httpFetchDurationMs: trace.fetchDurationMsByMethod.http,
      browserFetchDurationMs: trace.fetchDurationMsByMethod.browser,
    },
    execution: {
      requestId,
      planId: plan.id,
      plannerVersion: plan.plannerVersion,
      plannedStages: plan.stages.map((stage) => ({
        stageId: stage.id,
        provider: stage.provider,
        reasonCode: stage.reasonCode,
      })),
      executedStages: trace.executedStages,
    },
    cause: normalized,
  });
}

export class StageExecutor {
  constructor(
    private readonly cache: PageCache,
    private readonly httpFetcher: PageFetcher,
    private readonly browserFetcher: PageFetcher,
    private readonly crawlPolicy: CrawlRequestPolicy | null,
    private readonly attemptLedger: AttemptLedger | null,
  ) {}

  async execute(input: StageExecutionInput): Promise<StageExecutionResult> {
    const trace = emptyFetchTrace();
    const failures = new Map<string, ReadError>();
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), input.budget.deadlineMs);
    deadlineTimer.unref?.();
    const signal = input.signal === undefined
      ? deadlineController.signal
      : AbortSignal.any([input.signal, deadlineController.signal]);
    const startedAtMs = performance.now();
    let totalRetryDelayMs = 0;
    let artifact: PageReadArtifact | null = null;
    try {
      for (const stage of input.plan.stages) {
        if (!stageAllowed(stage, failures)) continue;
        if (!trace.executedStages.includes(stage.id)) trace.executedStages.push(stage.id);
        if (stage.provider === "cache") {
          const cached = this.executeCache(stage, input);
          if (cached instanceof ReadError) {
            failures.set(stage.id, cached);
            continue;
          }
          artifact = cached;
          break;
        }
        const method = stage.provider === "http" ? "http" : "browser";
        const operation = async (): Promise<PageReadArtifact> => {
          this.assertPreflightBudget(input, stage, trace, startedAtMs, method);
          return this.fetchAndExtract(input, stage, trace, signal, deadlineController, method);
        };
        try {
          const outcome = this.crawlPolicy === null
            ? { value: await operation(), attempts: 1, totalRetryDelayMs: 0 }
            : await this.crawlPolicy.execute(
                input.url,
                operation,
                signal,
                stage.retryPolicy,
                {
                  beforeRetryDelay: (milliseconds) => {
                    const elapsed = performance.now() - startedAtMs;
                    if (elapsed + milliseconds >= input.budget.deadlineMs) {
                      throw budgetError(
                        "deadlineMs",
                        input.budget.deadlineMs,
                        Math.ceil(elapsed + milliseconds),
                      );
                    }
                  },
                  onRetryDelay: (milliseconds) => {
                    trace.pendingRetryDelayMs += milliseconds;
                  },
                },
              );
          totalRetryDelayMs += outcome.totalRetryDelayMs;
          artifact = outcome.value;
          break;
        } catch (error) {
          const normalized = this.normalizeCancellation(error, input, deadlineController);
          totalRetryDelayMs += typeof normalized.details.totalRetryDelayMs === "number"
            ? normalized.details.totalRetryDelayMs
            : 0;
          failures.set(stage.id, normalized);
          if (normalized.code === "BUDGET_EXHAUSTED" || normalized.code === "CRAWL_CANCELLED") break;
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
    if (artifact === null) {
      const terminal = [...failures.values()].at(-1) ?? new ReadError(
        "INTERNAL_ERROR",
        "The access plan completed without an artifact or explicit failure.",
      );
      throw errorWithFetchTrace(terminal, trace, input.requestId, input.plan);
    }
    return { artifact, trace, totalRetryDelayMs };
  }

  private executeCache(stage: PlannedStage, input: StageExecutionInput): PageReadArtifact | ReadError {
    const startedAt = new Date().toISOString();
    const cached = this.cache.get(input.cacheKey, input.maxAgeSeconds);
    const completedAt = new Date().toISOString();
    if (cached !== null) {
      this.attemptLedger?.append({
        requestId: input.requestId,
        planId: input.plan.id,
        stageId: stage.id,
        provider: "cache",
        providerVersion: "page-cache-v1",
        outcome: "succeeded",
        rawRef: null,
        traceRef: null,
        errorCode: null,
        usage: emptyUsage(),
        startedAt,
        completedAt,
      });
      return { ...cached, cached: true };
    }
    const miss = new ReadError("CACHE_MISS", "No sufficiently fresh cached page is available.", {
      details: { url: input.url.toString(), maxAgeSeconds: input.maxAgeSeconds },
    });
    this.attemptLedger?.append({
      requestId: input.requestId,
      planId: input.plan.id,
      stageId: stage.id,
      provider: "cache",
      providerVersion: "page-cache-v1",
      outcome: "failed",
      rawRef: null,
      traceRef: null,
      errorCode: miss.code,
      usage: emptyUsage(),
      startedAt,
      completedAt,
    });
    return miss;
  }

  private assertPreflightBudget(
    input: StageExecutionInput,
    stage: PlannedStage,
    trace: FetchTrace,
    startedAtMs: number,
    method: "http" | "browser",
  ): void {
    const elapsed = performance.now() - startedAtMs;
    let error: ReadError | null = null;
    const attempts = trace.fetchAttempts.http + trace.fetchAttempts.browser;
    const networkBytes = trace.responseBytesByMethod.http + trace.responseBytesByMethod.browser;
    if (elapsed >= input.budget.deadlineMs) {
      error = budgetError("deadlineMs", input.budget.deadlineMs, Math.ceil(elapsed));
    } else if (attempts >= input.budget.maxAttempts) {
      error = budgetError("maxAttempts", input.budget.maxAttempts, attempts);
    } else if (networkBytes >= input.budget.maxDocumentBytes) {
      error = budgetError("maxDocumentBytes", input.budget.maxDocumentBytes, networkBytes);
    } else if (method === "browser" && trace.fetchAttempts.browser >= input.budget.maxBrowserContexts) {
      error = budgetError(
        "maxBrowserContexts",
        input.budget.maxBrowserContexts,
        trace.fetchAttempts.browser,
      );
    } else if (
      method === "browser" &&
      trace.fetchDurationMsByMethod.browser >= input.budget.maxBrowserMs
    ) {
      error = budgetError(
        "maxBrowserMs",
        input.budget.maxBrowserMs,
        Math.ceil(trace.fetchDurationMsByMethod.browser),
      );
    }
    if (error === null) return;
    const now = new Date().toISOString();
    this.attemptLedger?.append({
      requestId: input.requestId,
      planId: input.plan.id,
      stageId: stage.id,
      provider: method,
      providerVersion: `reader-${method}-v1`,
      outcome: "stopped",
      rawRef: null,
      traceRef: null,
      errorCode: error.code,
      usage: emptyUsage(),
      startedAt: now,
      completedAt: now,
    });
    throw error;
  }

  private async fetchAndExtract(
    input: StageExecutionInput,
    stage: PlannedStage,
    trace: FetchTrace,
    signal: AbortSignal,
    deadlineController: AbortController,
    method: "http" | "browser",
  ): Promise<PageReadArtifact> {
    const fetcher = method === "http" ? this.httpFetcher : this.browserFetcher;
    trace.fetchAttempts[method] += 1;
    const retryDelayMilliseconds = trace.pendingRetryDelayMs;
    trace.pendingRetryDelayMs = 0;
    const startedAt = new Date().toISOString();
    const startedAtMs = performance.now();
    const remainingBytes = input.budget.maxDocumentBytes -
      trace.responseBytesByMethod.http - trace.responseBytesByMethod.browser;
    let page: Awaited<ReturnType<PageFetcher["fetch"]>> | undefined;
    try {
      page = await fetcher.fetch(input.url, {
        ...(method === "browser" && input.authProfile !== null
          ? { authProfile: input.authProfile }
          : {}),
        signal,
        ...(method === "browser" && input.browserReadiness !== undefined
          ? { browserReadiness: input.browserReadiness }
          : {}),
        maxResponseBytes: remainingBytes,
        timeoutMs: method === "browser"
          ? Math.max(1, Math.floor(input.budget.maxBrowserMs - trace.fetchDurationMsByMethod.browser))
          : Math.max(1, input.budget.deadlineMs),
      });
      trace.responseBytesByMethod[method] += page.responseBytes;
      const durationMs = Math.max(0, performance.now() - startedAtMs);
      trace.fetchDurationMsByMethod[method] += durationMs;
      this.assertPostflightBudget(input, trace, method, durationMs);
      const extracted = extractPage(page, {
        allowIncompleteDocument: stage.input.completion.type === "discovery",
      });
      const artifact = this.artifact(input, page, extracted, trace);
      this.appendProviderAttempt(input, stage, method, page, null, durationMs, retryDelayMilliseconds);
      return artifact;
    } catch (error) {
      const durationMs = Math.max(0, performance.now() - startedAtMs);
      if (page === undefined) trace.fetchDurationMsByMethod[method] += durationMs;
      const normalized = this.normalizeCancellation(error, input, deadlineController);
      const limitIsBudget = normalized.code === "RESPONSE_TOO_LARGE" &&
        normalized.details.maxResponseBytes === remainingBytes;
      const finalError = limitIsBudget
        ? budgetError(
            "maxDocumentBytes",
            input.budget.maxDocumentBytes,
            typeof normalized.details.responseBytes === "number"
              ? normalized.details.responseBytes
              : typeof normalized.details.contentLength === "number"
                ? normalized.details.contentLength
                : input.budget.maxDocumentBytes + 1,
          )
        : method === "browser" &&
          trace.fetchDurationMsByMethod.browser > input.budget.maxBrowserMs
        ? budgetError(
            "maxBrowserMs",
            input.budget.maxBrowserMs,
            Math.ceil(trace.fetchDurationMsByMethod.browser),
          )
        : normalized;
      this.appendProviderAttempt(
        input,
        stage,
        method,
        page,
        finalError,
        durationMs,
        retryDelayMilliseconds,
      );
      throw finalError;
    }
  }

  private assertPostflightBudget(
    input: StageExecutionInput,
    trace: FetchTrace,
    method: "http" | "browser",
    durationMs: number,
  ): void {
    const bytes = trace.responseBytesByMethod.http + trace.responseBytesByMethod.browser;
    if (bytes > input.budget.maxDocumentBytes) {
      throw budgetError("maxDocumentBytes", input.budget.maxDocumentBytes, bytes);
    }
    if (method === "browser" && trace.fetchDurationMsByMethod.browser > input.budget.maxBrowserMs) {
      throw budgetError(
        "maxBrowserMs",
        input.budget.maxBrowserMs,
        Math.ceil(trace.fetchDurationMsByMethod.browser),
      );
    }
    void durationMs;
  }

  private normalizeCancellation(
    error: unknown,
    input: StageExecutionInput,
    deadlineController: AbortController,
  ): ReadError {
    if (input.signal?.aborted === true) {
      return new ReadError("CRAWL_CANCELLED", "The crawl job was cancelled.");
    }
    if (deadlineController.signal.aborted) {
      return budgetError("deadlineMs", input.budget.deadlineMs, input.budget.deadlineMs);
    }
    return normalizeError(error);
  }

  private appendProviderAttempt(
    input: StageExecutionInput,
    stage: PlannedStage,
    method: "http" | "browser",
    page: Awaited<ReturnType<PageFetcher["fetch"]>> | undefined,
    error: ReadError | null,
    durationMs: number,
    retryDelayMilliseconds: number,
  ): void {
    this.attemptLedger?.append({
      requestId: input.requestId,
      planId: input.plan.id,
      stageId: stage.id,
      provider: method,
      providerVersion: `reader-${method}-v1`,
      outcome: error === null ? "succeeded" : "failed",
      rawRef: page === undefined
        ? null
        : `sha256:${createHash("sha256").update(page.body).digest("hex")}`,
      traceRef: null,
      errorCode: error?.code ?? null,
      usage: {
        ...emptyUsage(),
        documentBytesIn: page?.responseBytes ?? 0,
        browserMilliseconds: method === "browser" ? durationMs : 0,
        browserContextStarts: method === "browser" ? 1 : 0,
        retryDelayMilliseconds,
      },
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      completedAt: new Date().toISOString(),
    });
  }

  private artifact(
    input: StageExecutionInput,
    page: Awaited<ReturnType<PageFetcher["fetch"]>>,
    extracted: ReturnType<typeof extractPage>,
    trace: FetchTrace,
  ): PageReadArtifact {
    return {
      status: "ok",
      sourceUrl: input.url.toString(),
      finalUrl: page.finalUrl,
      fetchedAt: page.fetchedAt,
      fetchMethod: page.method,
      authProfile: input.authProfile,
      cached: false,
      title: extracted.title,
      byline: extracted.byline,
      publishedTime: extracted.publishedTime,
      contentMarkdown: extracted.markdown,
      contentHash: extracted.contentHash,
      completeness: "complete",
      validation: validateContent(extracted),
      discoveredLinks: extracted.links,
      evidence: {
        httpStatus: page.httpStatus,
        contentType: page.contentType,
        responseBytes: page.responseBytes,
        contentCharacters: extracted.contentCharacters,
        extractionMethod: extracted.extractionMethod,
        requestId: input.requestId,
        accessPlan: {
          planId: input.plan.id,
          plannerVersion: input.plan.plannerVersion,
          plannedStages: input.plan.stages.map((value) => ({
            stageId: value.id,
            provider: value.provider,
            reasonCode: value.reasonCode,
          })),
          executedStages: trace.executedStages,
        },
        ...(page.browserReadiness === undefined ? {} : { browserReadiness: page.browserReadiness }),
        proxyUsed: page.proxyUsed ?? false,
        ...(page.agentIdentity === undefined ? {} : { agentIdentity: page.agentIdentity }),
        ...(page.rsl === undefined ? {} : { rsl: page.rsl }),
      },
    };
  }
}
