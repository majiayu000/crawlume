import { performance } from "node:perf_hooks";

import { CrawlRequestPolicy } from "../crawl-policy.js";
import { defaultExtractorRegistry } from "../extract.js";
import { normalizeError, ReadError } from "../errors.js";
import { AttemptLedger } from "../jobs.js";
import type {
  AccessPlan,
  AccessProviderId,
  BrowserReadinessPolicy,
  ExecutionBudget,
  ExtractedPage,
  PageReadArtifact,
  PlannedStage,
  RawPage,
  ReadIntent,
  ResourceUsage,
  ValidationResult,
} from "../types.js";
import { declaredCanonicalUrl, defaultValidatorRegistry } from "../validation.js";
import { ProviderRegistry, type ProviderStageResult } from "./providers.js";

export type FetchTrace = {
  fetchAttempts: Record<"http" | "browser", number>;
  responseBytesByMethod: Record<"http" | "browser", number>;
  fetchDurationMsByMethod: Record<"http" | "browser", number>;
  extractionDurationMs: number;
  validationDurationMs: number;
  executedStages: string[];
  pendingRetryDelayMs: number;
};

export type StageExecutionResult = {
  artifact: PageReadArtifact;
  artifactKey: string | null;
  trace: FetchTrace;
  totalRetryDelayMs: number;
  publication: {
    rawRef: string;
    extractorVersion: string;
    etag?: string;
    lastModified?: string;
  } | null;
};

type ExecutedStageArtifact = {
  artifact: PageReadArtifact;
  artifactKey: string | null;
  publication: StageExecutionResult["publication"];
};

function traceMethod(provider: AccessProviderId): "http" | "browser" | null {
  if (provider === "browser") return "browser";
  if (provider === "http" || provider === "feed" || provider === "pdf") return "http";
  return null;
}

export type StageExecutionInput = {
  url: URL;
  cacheKey: string;
  maxAgeSeconds: number;
  authProfile: string | null;
  browserReadiness?: BrowserReadinessPolicy;
  requestId: string;
  intent: ReadIntent;
  plan: AccessPlan;
  budget: ExecutionBudget;
  signal?: AbortSignal;
  onNetworkRequestStart?: () => void;
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
    extractionDurationMs: 0,
    validationDurationMs: 0,
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
    ...(normalized.traceRef === null ? {} : { traceRef: normalized.traceRef }),
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
      extractionDurationMs: trace.extractionDurationMs,
      validationDurationMs: trace.validationDurationMs,
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
    private readonly providers: ProviderRegistry,
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
    let artifactKey: string | null = null;
    let publication: StageExecutionResult["publication"] = null;
    try {
      for (const stage of input.plan.stages) {
        if (!stageAllowed(stage, failures)) continue;
        if (!trace.executedStages.includes(stage.id)) trace.executedStages.push(stage.id);
        const method = traceMethod(stage.provider);
        const operation = async (): Promise<ExecutedStageArtifact> => {
          this.assertPreflightBudget(input, stage, trace, startedAtMs, method);
          return this.executeProviderStage(
            input,
            stage,
            trace,
            signal,
            deadlineController,
            method,
          );
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
          artifact = outcome.value.artifact;
          artifactKey = outcome.value.artifactKey;
          publication = outcome.value.publication;
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
    return { artifact, artifactKey, trace, totalRetryDelayMs, publication };
  }

  private assertPreflightBudget(
    input: StageExecutionInput,
    stage: PlannedStage,
    trace: FetchTrace,
    startedAtMs: number,
    method: "http" | "browser" | null,
  ): void {
    const elapsed = performance.now() - startedAtMs;
    let error: ReadError | null = null;
    const attempts = trace.fetchAttempts.http + trace.fetchAttempts.browser;
    const networkBytes = trace.responseBytesByMethod.http + trace.responseBytesByMethod.browser;
    if (elapsed >= input.budget.deadlineMs) {
      error = budgetError("deadlineMs", input.budget.deadlineMs, Math.ceil(elapsed));
    } else if (method !== null && attempts >= input.budget.maxAttempts) {
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
      provider: stage.provider,
      providerVersion: "executor-budget-v1",
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

  private async executeProviderStage(
    input: StageExecutionInput,
    stage: PlannedStage,
    trace: FetchTrace,
    signal: AbortSignal,
    deadlineController: AbortController,
    method: "http" | "browser" | null,
  ): Promise<ExecutedStageArtifact> {
    if (method !== null) trace.fetchAttempts[method] += 1;
    const retryDelayMilliseconds = trace.pendingRetryDelayMs;
    trace.pendingRetryDelayMs = 0;
    const remainingBytes = input.budget.maxDocumentBytes -
      trace.responseBytesByMethod.http - trace.responseBytesByMethod.browser;
    const result = await this.providers.execute({
      stage,
      url: input.url,
      cacheKey: input.cacheKey,
      maxAgeSeconds: input.maxAgeSeconds,
      authProfile: input.authProfile,
      ...(input.browserReadiness === undefined
        ? {}
        : { browserReadiness: input.browserReadiness }),
      intent: input.intent,
      maxResponseBytes: remainingBytes,
      timeoutMs: method === "browser"
        ? Math.max(1, Math.floor(input.budget.maxBrowserMs - trace.fetchDurationMsByMethod.browser))
        : Math.max(1, input.budget.deadlineMs),
      ...(input.onNetworkRequestStart === undefined
        ? {}
        : { onNetworkRequestStart: input.onNetworkRequestStart }),
    }, signal);
    const durationMs = Math.max(0, Date.parse(result.completedAt) - Date.parse(result.startedAt));
    if (method !== null) {
      trace.responseBytesByMethod[method] += result.usage.documentBytesIn;
      trace.fetchDurationMsByMethod[method] += durationMs;
    }
    let finalError = result.error === null
      ? result.outcome === "succeeded"
        ? null
        : new ReadError("INTERNAL_ERROR", "A failed provider result must include an error.")
        : new ReadError(result.error.code, result.error.message, {
          retryable: result.error.retryable,
          details: result.error.details,
          ...(result.traceRef === null ? {} : { traceRef: result.traceRef }),
        });
    if (finalError !== null) {
      finalError = this.normalizeCancellation(finalError, input, deadlineController);
      if (
        finalError.code === "RESPONSE_TOO_LARGE" &&
        finalError.details.maxResponseBytes === remainingBytes
      ) {
        finalError = budgetError(
          "maxDocumentBytes",
          input.budget.maxDocumentBytes,
          typeof finalError.details.responseBytes === "number"
            ? finalError.details.responseBytes
            : typeof finalError.details.contentLength === "number"
              ? finalError.details.contentLength
              : input.budget.maxDocumentBytes + 1,
        );
      }
    }
    try {
      if (method !== null) this.assertPostflightBudget(input, trace, method);
    } catch (error) {
      finalError = normalizeError(error);
    }
    this.appendProviderAttempt(input, stage, result, finalError, retryDelayMilliseconds);
    if (finalError !== null) throw finalError;
    if (result.candidate === null) {
      throw new ReadError("INTERNAL_ERROR", "A successful provider result requires a candidate.");
    }
    if (result.candidate.kind === "artifact") {
      return {
        artifact: result.candidate.artifact,
        artifactKey: result.candidateArtifactRef,
        publication: null,
      };
    }
    const page = result.candidate.page;
    const selected = await this.extractAndValidate(input, page, trace);
    if (result.rawRef === null) {
      throw new ReadError("INTERNAL_ERROR", "A raw provider candidate requires rawRef.");
    }
    return {
      artifact: this.artifact(
        input,
        page,
        selected.extracted,
        selected.extractorVersion,
        selected.validation,
        trace,
      ),
      artifactKey: null,
      publication: {
        rawRef: result.rawRef,
        extractorVersion: selected.extractorVersion,
        ...(page.etag === undefined ? {} : { etag: page.etag }),
        ...(page.lastModified === undefined ? {} : { lastModified: page.lastModified }),
      },
    };
  }

  private async extractAndValidate(
    input: StageExecutionInput,
    page: RawPage,
    trace: FetchTrace,
  ): Promise<{ extracted: ExtractedPage; extractorVersion: string; validation: ValidationResult }> {
    const extractionStartedAt = performance.now();
    const extraction = await defaultExtractorRegistry.extract(page);
    trace.extractionDurationMs += Math.max(0, performance.now() - extractionStartedAt);
    type SelectedCandidate = {
      extracted: ExtractedPage;
      extractorVersion: string;
      validation: ValidationResult;
    };
    let selected: SelectedCandidate | null = null;
    let uncertain: SelectedCandidate | null = null;
    let invalid: SelectedCandidate | null = null;
    for (const candidate of extraction.candidates) {
      const validationStartedAt = performance.now();
      const validation = defaultValidatorRegistry.validate({
        intent: input.intent,
        page,
        candidate: candidate.artifact,
      });
      trace.validationDurationMs += Math.max(0, performance.now() - validationStartedAt);
      if (validation.outcome === "valid") {
        selected = {
          extracted: candidate.artifact,
          extractorVersion: candidate.extractorVersion,
          validation,
        };
        break;
      }
      if (validation.outcome === "uncertain" && uncertain === null) {
        uncertain = {
          extracted: candidate.artifact,
          extractorVersion: candidate.extractorVersion,
          validation,
        };
      } else if (validation.outcome === "invalid" && invalid === null) {
        invalid = {
          extracted: candidate.artifact,
          extractorVersion: candidate.extractorVersion,
          validation,
        };
      }
    }
    selected ??= uncertain;
    if (selected !== null) return selected;
    const terminal = invalid?.validation.terminalError;
    if (invalid === null || terminal === null || terminal === undefined) {
      throw new ReadError("INTERNAL_ERROR", "Invalid validation requires a terminal error.");
    }
    throw new ReadError(terminal.code, terminal.message, {
      details: {
        extractorVersion: invalid.extractorVersion,
        validatorVersion: invalid.validation.validatorVersion,
      },
    });
  }

  private assertPostflightBudget(
    input: StageExecutionInput,
    trace: FetchTrace,
    method: "http" | "browser",
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
    result: ProviderStageResult,
    error: ReadError | null,
    retryDelayMilliseconds: number,
  ): void {
    const outcome = error?.code === "BUDGET_EXHAUSTED" ? "stopped" : result.outcome;
    this.attemptLedger?.append({
      requestId: input.requestId,
      planId: input.plan.id,
      stageId: stage.id,
      provider: stage.provider,
      providerVersion: result.providerVersion,
      outcome,
      rawRef: result.rawRef,
      traceRef: result.traceRef,
      errorCode: error?.code ?? null,
      usage: { ...result.usage, retryDelayMilliseconds },
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    });
  }

  private artifact(
    input: StageExecutionInput,
    page: RawPage,
    extracted: ExtractedPage,
    extractorVersion: string,
    validation: ValidationResult,
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
      completeness: validation.outcome === "valid" ? "complete" : "uncertain",
      validation,
      discoveredLinks: extracted.links,
      evidence: {
        httpStatus: page.httpStatus,
        contentType: page.contentType,
        responseBytes: page.responseBytes,
        contentCharacters: extracted.contentCharacters,
        extractionMethod: extracted.extractionMethod,
        extractorVersion,
        validatorVersion: validation.validatorVersion,
        phaseDurationsMs: {
          extraction: trace.extractionDurationMs,
          validation: trace.validationDurationMs,
        },
        cacheStatus: "live",
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
        urlIdentity: {
          redirects: page.redirects ?? [],
          declaredCanonicalUrl: declaredCanonicalUrl(page),
        },
      },
    };
  }
}
