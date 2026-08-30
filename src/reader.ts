import { createHash, randomUUID } from "node:crypto";

import { PageCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { CrawlRequestPolicy } from "./crawl-policy.js";
import { normalizeError, ReadError } from "./errors.js";
import { LocalPageIndex } from "./index.js";
import { AttemptLedger } from "./jobs.js";
import { CrawlerMetrics } from "./metrics.js";
import { planAccess } from "./reliability/planner.js";
import type { ExecutionBudget, InspectPageResult, PageReadArtifact, PageFetcher, ReadIntent, ReadPageOptions, ReadPageResult } from "./types.js";
import {
  normalizeBrowserReadinessPolicy,
  type NormalizedBrowserReadinessPolicy,
} from "./runtime/readiness.js";
import { StageExecutor } from "./runtime/executor.js";
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

type ReadExecutionOptions = ReadPageOptions & { signal?: AbortSignal };

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

export class ReaderService {
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
  ) {}

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
      this.rslAudit?.recordFailure(options.url, normalized);
      this.metrics?.recordFailure(normalized, Date.now() - startedAt);
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
    const cacheMode = options.cacheMode ?? "prefer-cache";
    const maxAgeSeconds = options.maxAgeSeconds ?? this.config.defaultCacheSeconds;
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
      throw new ReadError("INVALID_ARGUMENT", "maxAgeSeconds must be a positive integer.");
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

    const url = this.urlPolicy.parse(options.url);
    await this.urlPolicy.assertPublic(url);
    const requestId = options.requestId ?? randomUUID();
    if (requestId.trim().length === 0) {
      throw new ReadError("INVALID_ARGUMENT", "requestId must be non-empty when provided.");
    }
    const authProfile = options.authProfile ?? null;
    const budget = options.budget ?? defaultExecutionBudget(this.config, browserAllowed);
    const plan = planAccess({
      url: url.toString(),
      operation,
      output: { format: "markdown" },
      freshness: { maxAgeSeconds, allowStaleWhileRevalidate: false },
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
    }, {
      cachePolicy: cacheMode,
      providers: { cache: true, http: true, browser: browserAllowed },
    });
    const key = createHash("sha256")
      .update(cacheKey(
        url.toString(),
        operation === "map" ? "discovery" : "content",
        authProfile,
        browserReadiness,
        this.config,
      ))
      .update(this.rslApprovalContextHash())
      .digest("hex");
    const { artifact, trace, totalRetryDelayMs } = await new StageExecutor(
      this.cache,
      this.httpFetcher,
      this.browserFetcher,
      this.crawlPolicy,
      this.attemptLedger,
    ).execute({
      url,
      cacheKey: key,
      maxAgeSeconds,
      authProfile,
      ...(browserReadiness === undefined ? {} : { browserReadiness }),
      requestId,
      plan,
      budget,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
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

    if (operation !== "map" && (result.evidence.rsl?.licenseTokensApplied ?? 0) === 0) {
      this.cache.put(key, result);
      this.localIndex?.put(result);
    }
    return result;
  }

  async inspectPage(options: ReadPageOptions): Promise<InspectPageResult> {
    return withoutContent(await this.readPage(options));
  }

  close(): void {
    this.cache.close();
  }
}
