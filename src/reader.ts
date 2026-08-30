import { createHash } from "node:crypto";

import { PageCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { CrawlRequestPolicy } from "./crawl-policy.js";
import { normalizeError, ReadError } from "./errors.js";
import { LocalPageIndex } from "./index.js";
import { AttemptLedger } from "./jobs.js";
import { CrawlerMetrics } from "./metrics.js";
import { normalizeReadRequest } from "./reliability/read-intent.js";
import type { InspectPageResult, PageReadArtifact, PageFetcher, ReadPageOptions, ReadPageResult } from "./types.js";
import type { NormalizedBrowserReadinessPolicy } from "./runtime/readiness.js";
import { StageExecutor, type StageExecutionResult } from "./runtime/executor.js";
import { createBuiltinProviderRegistry, type ProviderRegistry } from "./runtime/providers.js";
import { RuntimeResourceGovernor } from "./runtime/runtime-resource-governor.js";
import { UrlPolicy } from "./security/url-policy.js";
import type { RslAccessAudit } from "./rsl-audit.js";

function cacheKey(
  url: string,
  artifactKind: "content" | "discovery",
  authProfile: string | null,
  browserReadiness: NormalizedBrowserReadinessPolicy | undefined,
  config: AppConfig,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: 6,
        url,
        artifactKind,
        authProfile,
        browserReadiness: browserReadiness ?? null,
        userAgent: config.userAgent,
        rslUsage: config.rslUsage,
        rslUserClass: config.rslUserClass,
        rslGeo: config.rslGeo,
      }),
    )
    .digest("hex");
}

function withoutContent(result: ReadPageResult): InspectPageResult {
  const { contentMarkdown: _contentMarkdown, ...inspection } = result;
  return inspection;
}

function withoutLinks(result: PageReadArtifact): ReadPageResult {
  const { discoveredLinks: _discoveredLinks, ...page } = result;
  return page;
}

function failureTerminalState(error: ReadError):
  "invalid" | "failed" | "policy_stop" | "budget_exhausted" | "cancelled" {
  if (error.code === "BUDGET_EXHAUSTED") return "budget_exhausted";
  if (error.code === "CRAWL_CANCELLED") return "cancelled";
  if (
    error.code === "SHELL_ONLY" || error.code === "INCOMPLETE_CONTENT" ||
    error.code === "UNSUPPORTED_CONTENT_TYPE"
  ) return "invalid";
  if (
    error.code === "ROBOTS_DISALLOWED" || error.code === "ROBOTS_UNAVAILABLE" ||
    error.code.startsWith("RSL_") || error.code === "AUTH_REQUIRED" ||
    error.code === "PAYMENT_REQUIRED" || error.code === "ACCESS_DENIED" ||
    error.code === "LOGIN_WALL_DETECTED" || error.code === "HUMAN_VERIFICATION_REQUIRED"
  ) {
    return "policy_stop";
  }
  return "failed";
}

type ReadExecutionOptions = ReadPageOptions & { signal?: AbortSignal };

export class ReaderService {
  private readonly backgroundRevalidations = new Map<string, Promise<void>>();
  private readonly backgroundFailures: unknown[] = [];
  private readonly providers: ProviderRegistry;

  constructor(
    private readonly config: AppConfig,
    private readonly urlPolicy: UrlPolicy,
    private readonly cache: PageCache,
    private readonly httpFetcher: PageFetcher,
    private readonly browserFetcher: PageFetcher,
    private readonly localIndex: LocalPageIndex | null = null,
    private readonly crawlPolicy: CrawlRequestPolicy | null = null,
    private readonly metrics: CrawlerMetrics | null = null,
    private readonly rslAudit: RslAccessAudit | null = null,
    private readonly rslApprovalContextHash: () => string = () => "",
    private readonly attemptLedger: AttemptLedger | null = null,
    private readonly resources = new RuntimeResourceGovernor(config),
  ) {
    this.providers = createBuiltinProviderRegistry(cache, httpFetcher, browserFetcher, resources);
  }

  async readPage(options: ReadPageOptions): Promise<ReadPageResult> {
    return withoutLinks(await this.readPageArtifact(options));
  }

  async readPageArtifact(options: ReadExecutionOptions): Promise<PageReadArtifact> {
    return this.executeRecordedPageArtifact(options, "read");
  }

  async discoverPageArtifact(options: ReadExecutionOptions): Promise<PageReadArtifact> {
    return this.executeRecordedPageArtifact(options, "map");
  }

  async crawlPageArtifact(options: ReadExecutionOptions): Promise<PageReadArtifact> {
    return this.executeRecordedPageArtifact(options, "crawl");
  }

  private async executeRecordedPageArtifact(
    options: ReadExecutionOptions,
    operation: "read" | "map" | "crawl",
  ): Promise<PageReadArtifact> {
    const startedAt = Date.now();
    let result: PageReadArtifact;
    try {
      result = await this.executePageArtifact(options, operation);
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.execution !== null) {
        this.attemptLedger?.commitTerminal({
          requestId: normalized.execution.requestId,
          planId: normalized.execution.planId,
          state: failureTerminalState(normalized),
          artifactKey: null,
          contentHash: null,
          validatorVersion: null,
          error: {
            code: normalized.code,
            message: normalized.message,
            retryable: normalized.retryable,
            details: normalized.details,
          },
        });
      }
      this.rslAudit?.recordFailure(options.url, normalized);
      this.metrics?.recordFailure(
        normalized,
        Date.now() - startedAt,
        failureTerminalState(normalized),
      );
      throw error;
    }
    this.rslAudit?.recordSuccess(result);
    this.metrics?.recordSuccess(result, Date.now() - startedAt);
    return result;
  }

  private async executePageArtifact(
    options: ReadExecutionOptions,
    operation: "read" | "map" | "crawl",
  ): Promise<PageReadArtifact> {
    const url = this.urlPolicy.parse(options.url);
    await this.urlPolicy.assertPublic(url);
    const {
      requestId,
      cacheMode,
      maxAgeSeconds,
      staleWhileRevalidateSeconds,
      authProfile,
      browserReadiness,
      budget,
      intent,
      plan,
    } = normalizeReadRequest(this.config, url, options, operation);
    const approvalContextHash = this.rslApprovalContextHash();
    const key = createHash("sha256")
      .update(cacheKey(
        url.toString(),
        operation === "map" ? "discovery" : "content",
        authProfile,
        browserReadiness,
        this.config,
      ))
      .update(approvalContextHash)
      .digest("hex");
    const terminal = this.attemptLedger?.getTerminal(requestId, plan.id) ?? null;
    if (terminal !== null) {
      if (terminal.error !== null) {
        throw new ReadError(terminal.error.code, terminal.error.message, {
          retryable: terminal.error.retryable,
          details: terminal.error.details,
        });
      }
      if (terminal.artifactKey === null) {
        throw new ReadError("INTERNAL_ERROR", "Completed request terminal has no artifact ref.");
      }
      const replayed = this.cache.getArtifact(terminal.artifactKey);
      if (replayed === null) {
        throw new ReadError("INTERNAL_ERROR", "Committed request artifact is unavailable.", {
          details: { requestId, artifactKey: terminal.artifactKey },
        });
      }
      return {
        ...replayed,
        cached: true,
        evidence: { ...replayed.evidence, cacheStatus: "replayed" },
      };
    }
    const stale = cacheMode === "prefer-cache" && staleWhileRevalidateSeconds > 0
      ? this.cache.getStale(key, maxAgeSeconds, staleWhileRevalidateSeconds)
      : null;
    let execution: StageExecutionResult;
    if (stale !== null) {
      this.scheduleBackgroundRevalidation(key, options, operation);
      execution = {
        artifact: {
          ...stale,
          cached: true,
          evidence: { ...stale.evidence, cacheStatus: "stale" },
        },
        trace: {
          fetchAttempts: { http: 0, browser: 0 },
          responseBytesByMethod: { http: 0, browser: 0 },
          fetchDurationMsByMethod: { http: 0, browser: 0 },
          extractionDurationMs: 0,
          validationDurationMs: 0,
          executedStages: ["cache-read"],
          pendingRetryDelayMs: 0,
        },
        totalRetryDelayMs: 0,
        artifactKey: this.cache.lookup(key)?.artifactKey ?? null,
        publication: null,
      };
    } else {
      execution = await new StageExecutor(
        this.providers,
        this.crawlPolicy,
        this.attemptLedger,
      ).execute({
        url,
        cacheKey: key,
        maxAgeSeconds,
        authProfile,
        ...(browserReadiness === undefined ? {} : { browserReadiness }),
        requestId,
        intent,
        plan,
        budget,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    const {
      artifact,
      artifactKey: executionArtifactKey,
      trace,
      totalRetryDelayMs,
      publication,
    } = execution;
    const result: PageReadArtifact = {
      ...artifact,
      evidence: {
        ...artifact.evidence,
        attempts: trace.fetchAttempts.http + trace.fetchAttempts.browser,
        retryAttempts: Math.max(
          0,
          trace.fetchAttempts.http + trace.fetchAttempts.browser -
            trace.executedStages.filter((stageId) => stageId !== "cache-read").length,
        ),
        totalRetryDelayMs,
        fetchAttempts: trace.fetchAttempts,
        responseBytesByMethod: trace.responseBytesByMethod,
        fetchDurationMsByMethod: trace.fetchDurationMsByMethod,
        requestId,
        accessPlan: {
          planId: plan.id,
          plannerVersion: plan.plannerVersion,
          plannedStages: plan.stages.map((stage) => ({
            stageId: stage.id,
            provider: stage.provider,
            reasonCode: stage.reasonCode,
          })),
          executedStages: trace.executedStages,
        },
      },
    };

    let artifactKey = executionArtifactKey;
    if (operation !== "map" && publication !== null) {
      artifactKey = this.cache.put(key, result, {
        intent,
        approvalContextHash,
        rawRef: publication.rawRef,
        extractorVersion: publication.extractorVersion,
      }, {
        ...(publication.etag === undefined ? {} : { etag: publication.etag }),
        ...(publication.lastModified === undefined
          ? {}
          : { lastModified: publication.lastModified }),
      });
      if (artifactKey !== null) this.localIndex?.put(result);
    }
    if (operation !== "map" && artifactKey !== null) {
      this.attemptLedger?.commitTerminal({
        requestId,
        planId: plan.id,
        state: result.completeness === "complete" ? "completed" : "completed_uncertain",
        artifactKey,
        contentHash: result.contentHash,
        validatorVersion: result.validation.validatorVersion,
        error: null,
      });
    }
    return result;
  }

  async inspectPage(options: ReadPageOptions): Promise<InspectPageResult> {
    return withoutContent(await this.readPage(options));
  }

  async drainBackgroundRevalidations(): Promise<void> {
    while (this.backgroundRevalidations.size > 0) {
      await Promise.all([...this.backgroundRevalidations.values()]);
    }
    if (this.backgroundFailures.length > 0) {
      throw new AggregateError(
        this.backgroundFailures.splice(0),
        "One or more stale cache revalidations failed.",
      );
    }
  }

  close(): void | Promise<void> {
    if (this.backgroundRevalidations.size === 0) {
      if (this.backgroundFailures.length > 0) {
        throw new AggregateError(
          this.backgroundFailures.splice(0),
          "One or more stale cache revalidations failed.",
        );
      }
      this.cache.close();
      return;
    }
    return this.closeAfterBackgroundRevalidation();
  }

  private scheduleBackgroundRevalidation(
    key: string,
    options: ReadExecutionOptions,
    operation: "read" | "map" | "crawl",
  ): void {
    if (this.backgroundRevalidations.has(key)) return;
    const {
      signal: _signal,
      requestId: _requestId,
      staleWhileRevalidateSeconds: _staleWhileRevalidateSeconds,
      ...refreshOptions
    } = options;
    const revalidation = this.executeRecordedPageArtifact(
      { ...refreshOptions, cacheMode: "live" },
      operation,
    ).then(
      () => undefined,
      (error: unknown) => {
        this.backgroundFailures.push(error);
      },
    ).finally(() => {
      this.backgroundRevalidations.delete(key);
    });
    this.backgroundRevalidations.set(key, revalidation);
  }

  private async closeAfterBackgroundRevalidation(): Promise<void> {
    try {
      await this.drainBackgroundRevalidations();
    } finally {
      this.cache.close();
    }
  }
}
