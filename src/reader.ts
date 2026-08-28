import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { PageCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { CrawlRequestPolicy } from "./crawl-policy.js";
import { extractPage } from "./extract.js";
import { normalizeError, ReadError } from "./errors.js";
import { LocalPageIndex } from "./index.js";
import { CrawlerMetrics } from "./metrics.js";
import type {
  BrowserReadinessPolicy,
  InspectPageResult,
  PageReadArtifact,
  PageFetcher,
  ReadPageOptions,
  ReadPageResult,
} from "./types.js";
import {
  normalizeBrowserReadinessPolicy,
  type NormalizedBrowserReadinessPolicy,
} from "./runtime/readiness.js";
import { UrlPolicy } from "./security/url-policy.js";
import { validateContent } from "./validation.js";
import type { RslAccessAudit } from "./rsl-audit.js";

function cacheKey(
  url: string,
  mode: string,
  authProfile: string | null,
  browserReadiness: NormalizedBrowserReadinessPolicy | undefined,
  config: AppConfig,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: 5,
        url,
        mode,
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
type FetchTrace = {
  fetchAttempts: Record<"http" | "browser", number>;
  responseBytesByMethod: Record<"http" | "browser", number>;
  fetchDurationMsByMethod: Record<"http" | "browser", number>;
};

function emptyFetchTrace(): FetchTrace {
  return {
    fetchAttempts: { http: 0, browser: 0 },
    responseBytesByMethod: { http: 0, browser: 0 },
    fetchDurationMsByMethod: { http: 0, browser: 0 },
  };
}

function errorWithFetchTrace(error: unknown, trace: FetchTrace): ReadError {
  const normalized = normalizeError(error);
  return new ReadError(normalized.code, normalized.message, {
    retryable: normalized.retryable,
    details: {
      ...normalized.details,
      httpFetchAttempts: trace.fetchAttempts.http,
      browserFetchAttempts: trace.fetchAttempts.browser,
      httpResponseBytes: trace.responseBytesByMethod.http,
      browserResponseBytes: trace.responseBytesByMethod.browser,
      httpFetchDurationMs: trace.fetchDurationMsByMethod.http,
      browserFetchDurationMs: trace.fetchDurationMsByMethod.browser,
    },
    cause: normalized,
  });
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
  ) {}

  async readPage(options: ReadPageOptions): Promise<ReadPageResult> {
    return withoutLinks(await this.readPageArtifact(options));
  }

  async readPageArtifact(options: ReadExecutionOptions): Promise<PageReadArtifact> {
    const startedAt = Date.now();
    let result: PageReadArtifact;
    try {
      result = await this.executeReadPageArtifact(options);
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

  private async executeReadPageArtifact(options: ReadExecutionOptions): Promise<PageReadArtifact> {
    const mode = options.mode ?? "auto";
    const cacheMode = options.cacheMode ?? "prefer-cache";
    const maxAgeSeconds = options.maxAgeSeconds ?? this.config.defaultCacheSeconds;
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
      throw new ReadError("INVALID_ARGUMENT", "maxAgeSeconds must be a positive integer.");
    }
    if (options.authProfile !== undefined && mode === "http") {
      throw new ReadError("INVALID_ARGUMENT", "authProfile requires auto or browser mode.", {
        details: { mode },
      });
    }
    if (options.browserReadiness !== undefined && mode === "http") {
      throw new ReadError("INVALID_ARGUMENT", "browserReadiness requires auto or browser mode.", {
        details: { mode },
      });
    }
    const browserReadiness = options.browserReadiness === undefined
      ? undefined
      : normalizeBrowserReadinessPolicy(options.browserReadiness);

    const url = this.urlPolicy.parse(options.url);
    await this.urlPolicy.assertPublic(url);
    const authProfile = options.authProfile ?? null;
    const key = createHash("sha256")
      .update(cacheKey(url.toString(), mode, authProfile, browserReadiness, this.config))
      .update(this.rslApprovalContextHash())
      .digest("hex");

    if (cacheMode !== "live") {
      const cached = this.cache.get(key, maxAgeSeconds);
      if (cached !== null) {
        this.localIndex?.put(cached);
        return { ...cached, cached: true };
      }
      if (cacheMode === "cache-only") {
        throw new ReadError("CACHE_MISS", "No sufficiently fresh cached page is available.", {
          details: { url: url.toString(), maxAgeSeconds },
        });
      }
    }

    const trace = emptyFetchTrace();
    const operation = async (): Promise<PageReadArtifact> =>
      this.fetchWithMode(url, mode, authProfile, browserReadiness, trace, options.signal);
    let attempt: {
      value: PageReadArtifact;
      attempts: number;
      totalRetryDelayMs: number;
    };
    try {
      attempt = this.crawlPolicy === null
        ? { value: await operation(), attempts: 1, totalRetryDelayMs: 0 }
        : await this.crawlPolicy.execute(url, operation, options.signal);
    } catch (error) {
      throw errorWithFetchTrace(error, trace);
    }
    const result: PageReadArtifact = {
      ...attempt.value,
      evidence: {
        ...attempt.value.evidence,
        attempts: attempt.attempts,
        totalRetryDelayMs: attempt.totalRetryDelayMs,
        fetchAttempts: trace.fetchAttempts,
        responseBytesByMethod: trace.responseBytesByMethod,
        fetchDurationMsByMethod: trace.fetchDurationMsByMethod,
      },
    };

    if ((result.evidence.rsl?.licenseTokensApplied ?? 0) === 0) {
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

  private async fetchAndExtract(
    sourceUrl: URL,
    fetcher: PageFetcher,
    method: "http" | "browser",
    trace: FetchTrace,
    authProfile: string | null,
    browserReadiness: BrowserReadinessPolicy | undefined,
    signal?: AbortSignal,
  ): Promise<PageReadArtifact> {
    trace.fetchAttempts[method] += 1;
    const startedAt = performance.now();
    let page: Awaited<ReturnType<PageFetcher["fetch"]>>;
    try {
      page = await fetcher.fetch(sourceUrl, {
        ...(authProfile === null ? {} : { authProfile }),
        ...(signal === undefined ? {} : { signal }),
        ...(browserReadiness === undefined ? {} : { browserReadiness }),
      });
    } finally {
      trace.fetchDurationMsByMethod[method] += Math.max(0, performance.now() - startedAt);
    }
    trace.responseBytesByMethod[method] += page.responseBytes;
    const extracted = extractPage(page);
    return {
      status: "ok",
      sourceUrl: sourceUrl.toString(),
      finalUrl: page.finalUrl,
      fetchedAt: page.fetchedAt,
      fetchMethod: page.method,
      authProfile,
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
        ...(page.browserReadiness === undefined
          ? {}
          : { browserReadiness: page.browserReadiness }),
        proxyUsed: page.proxyUsed ?? false,
        ...(page.agentIdentity === undefined ? {} : { agentIdentity: page.agentIdentity }),
        ...(page.rsl === undefined ? {} : { rsl: page.rsl }),
      },
    };
  }

  private async fetchWithMode(
    url: URL,
    mode: "auto" | "http" | "browser",
    authProfile: string | null,
    browserReadiness: BrowserReadinessPolicy | undefined,
    trace: FetchTrace,
    signal: AbortSignal | undefined,
  ): Promise<PageReadArtifact> {
    if (mode === "http") {
      return this.fetchAndExtract(url, this.httpFetcher, "http", trace, null, undefined, signal);
    }
    if (mode === "browser" || authProfile !== null || browserReadiness !== undefined) {
      return this.fetchAndExtract(
        url,
        this.browserFetcher,
        "browser",
        trace,
        authProfile,
        browserReadiness,
        signal,
      );
    }
    try {
      return await this.fetchAndExtract(
        url, this.httpFetcher, "http", trace, null, undefined, signal,
      );
    } catch (error) {
      if (
        !(error instanceof ReadError) ||
        (error.code !== "SHELL_ONLY" && error.code !== "INCOMPLETE_CONTENT")
      ) {
        throw error;
      }
      try {
        return await this.fetchAndExtract(
          url, this.browserFetcher, "browser", trace, null, undefined, signal,
        );
      } catch (browserFailure) {
        if (browserFailure instanceof ReadError && browserFailure.code === "BROWSER_UNAVAILABLE") {
          throw new ReadError(
            "BROWSER_UNAVAILABLE",
            "HTTP returned incomplete content and the browser fallback is unavailable.",
            {
              details: {
                url: url.toString(),
                httpFailure: error.code,
                browserFailure: browserFailure.message,
              },
              cause: browserFailure,
            },
          );
        }
        throw browserFailure;
      }
    }
  }
}
