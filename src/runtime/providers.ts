import { performance } from "node:perf_hooks";

import { PageCache } from "../cache.js";
import { normalizeError, ReadError } from "../errors.js";
import type {
  AccessProviderId,
  BrowserReadinessPolicy,
  PageFetcher,
  PageReadArtifact,
  PlannedStage,
  RawPage,
  ReadIntent,
  ResourceUsage,
  StageResult,
} from "../types.js";
import { accessProviderIds } from "../types.js";
import {
  RuntimeResourceGovernor,
  type RuntimeResourceLease,
} from "./runtime-resource-governor.js";

export type ProviderCapabilities = {
  id: AccessProviderId;
  version: string;
  output: "artifact" | "raw";
  credentialHandling: "none" | "profile";
  mediaTypes: readonly string[];
};

export type ProviderExecutionRequest = {
  stage: PlannedStage;
  url: URL;
  cacheKey: string;
  maxAgeSeconds: number;
  authProfile: string | null;
  browserReadiness?: BrowserReadinessPolicy;
  intent: ReadIntent;
  maxResponseBytes: number;
  timeoutMs: number;
};

export type ProviderCandidate =
  | { kind: "artifact"; artifact: PageReadArtifact }
  | { kind: "raw"; page: RawPage };

export type ProviderStageResult = Readonly<StageResult & {
  providerVersion: string;
  candidate: ProviderCandidate | null;
}>;

export interface AccessProvider {
  capabilities(): ProviderCapabilities;
  execute(
    request: ProviderExecutionRequest,
    signal: AbortSignal,
  ): Promise<ProviderStageResult>;
}

export type ProviderRegistration = {
  id: AccessProviderId;
  availability: "available" | "unavailable";
  version: string | null;
  reason: string | null;
};

function zeroProviderUsage(): ResourceUsage {
  return {
    documentBytesIn: 0,
    networkBytesOut: 0,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryDelayMilliseconds: 0,
    optionalModelTokens: 0,
  };
}

function providerFailureResult(
  stageId: string,
  providerVersion: string,
  error: ReadError,
  startedAt: string,
  outcome: StageResult["outcome"] = "failed",
  usage: ResourceUsage = zeroProviderUsage(),
  rawRef: string | null = null,
): ProviderStageResult {
  return Object.freeze({
    stageId,
    providerVersion,
    outcome,
    rawRef,
    traceRef: error.traceRef,
    candidateArtifactRef: null,
    candidate: null,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
    usage,
    startedAt,
    completedAt: new Date().toISOString(),
  });
}

function unavailable(id: string, reason: string): ReadError {
  return new ReadError("PROVIDER_UNAVAILABLE", `Provider ${id} is unavailable: ${reason}`, {
    details: { provider: id, reason },
  });
}

export class ProviderRegistry {
  private readonly providers = new Map<AccessProviderId, AccessProvider>();
  private readonly unavailableReasons = new Map<AccessProviderId, string>();

  constructor() {
    for (const id of accessProviderIds) {
      this.unavailableReasons.set(id, "no implementation is registered");
    }
  }

  register(provider: AccessProvider): void {
    const capabilities = provider.capabilities();
    if (this.providers.has(capabilities.id)) {
      throw new ReadError("INVALID_ARGUMENT", `Provider ${capabilities.id} is already registered.`, {
        details: { provider: capabilities.id },
      });
    }
    this.providers.set(capabilities.id, provider);
    this.unavailableReasons.delete(capabilities.id);
  }

  declareUnavailable(id: AccessProviderId, reason: string): void {
    if (this.providers.has(id)) {
      throw new ReadError("INVALID_ARGUMENT", `Available provider ${id} cannot be redeclared.`, {
        details: { provider: id },
      });
    }
    this.unavailableReasons.set(id, reason);
  }

  resolve(id: AccessProviderId): AccessProvider {
    if (!(accessProviderIds as readonly string[]).includes(id)) {
      throw new ReadError("INVALID_ARGUMENT", "The access plan contains an unknown provider.", {
        details: { provider: id },
      });
    }
    const provider = this.providers.get(id);
    if (provider !== undefined) return provider;
    throw unavailable(id, this.unavailableReasons.get(id) ?? "no implementation is registered");
  }

  list(): ProviderRegistration[] {
    return accessProviderIds.map((id) => {
      const provider = this.providers.get(id);
      if (provider !== undefined) {
        return {
          id,
          availability: "available" as const,
          version: provider.capabilities().version,
          reason: null,
        };
      }
      return {
        id,
        availability: "unavailable" as const,
        version: null,
        reason: this.unavailableReasons.get(id) ?? "no implementation is registered",
      };
    });
  }

  async execute(
    request: ProviderExecutionRequest,
    signal: AbortSignal,
  ): Promise<ProviderStageResult> {
    const startedAt = new Date().toISOString();
    let provider: AccessProvider;
    try {
      provider = this.resolve(request.stage.provider);
    } catch (error) {
      return providerFailureResult(
        request.stage.id,
        "unavailable",
        normalizeError(error),
        startedAt,
      );
    }
    return provider.execute(request, signal);
  }
}

class CacheAccessProvider implements AccessProvider {
  constructor(private readonly cache: PageCache) {}

  capabilities(): ProviderCapabilities {
    return {
      id: "cache",
      version: "page-cache-provider-v1",
      output: "artifact",
      credentialHandling: "none",
      mediaTypes: ["*/*"],
    };
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderStageResult> {
    const startedAt = new Date().toISOString();
    const entry = this.cache.lookup(request.cacheKey);
    if (
      entry === null ||
      entry.validatedAtMs < Date.now() - request.maxAgeSeconds * 1_000
    ) {
      return providerFailureResult(
        request.stage.id,
        this.capabilities().version,
        new ReadError("CACHE_MISS", "No sufficiently fresh cached page is available.", {
          details: { url: request.url.toString(), maxAgeSeconds: request.maxAgeSeconds },
        }),
        startedAt,
      );
    }
    return Object.freeze({
      stageId: request.stage.id,
      providerVersion: this.capabilities().version,
      outcome: "succeeded" as const,
      rawRef: entry.rawRef,
      traceRef: null,
      candidateArtifactRef: entry.artifactKey,
      candidate: {
        kind: "artifact" as const,
        artifact: {
          ...entry.artifact,
          cached: true,
          evidence: { ...entry.artifact.evidence, cacheStatus: "fresh" as const },
        },
      },
      error: null,
      usage: zeroProviderUsage(),
      startedAt,
      completedAt: new Date().toISOString(),
    });
  }
}

function isPdf(page: RawPage): boolean {
  if (page.contentType.toLowerCase().includes("application/pdf")) return true;
  const bytes = page.bodyBytes ?? new Uint8Array(Buffer.from(page.body));
  return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

function isFeed(page: RawPage): boolean {
  return /<(?:rss|feed)\b/iu.test(page.body.slice(0, 2_048));
}

class FetchAccessProvider implements AccessProvider {
  constructor(
    private readonly id: "http" | "browser" | "feed" | "pdf",
    private readonly cache: PageCache,
    private readonly fetcher: PageFetcher,
    private readonly resources: RuntimeResourceGovernor | null,
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      version: `${this.id}-provider-v1`,
      output: "raw",
      credentialHandling: this.id === "browser" ? "profile" : "none",
      mediaTypes: this.id === "feed"
        ? ["application/rss+xml", "application/atom+xml"]
        : this.id === "pdf"
          ? ["application/pdf"]
          : ["*/*"],
    };
  }

  async execute(
    request: ProviderExecutionRequest,
    signal: AbortSignal,
  ): Promise<ProviderStageResult> {
    const startedAt = new Date().toISOString();
    const startedAtMs = performance.now();
    let page: RawPage | null = null;
    let rawRef: string | null = null;
    let lease: RuntimeResourceLease | null = null;
    let observationError: ReadError | null = null;
    try {
      lease = await this.resources?.acquire({
        provider: this.id,
        origin: request.url.origin,
        authProfile: this.id === "browser" ? request.authProfile : null,
      }, signal) ?? null;
      const cached = this.id === "browser" ? null : this.cache.lookup(request.cacheKey);
      const fetchPage = async (sharedSignal: AbortSignal) => this.fetcher.fetch(request.url, {
        ...(this.id === "browser" && request.authProfile !== null
          ? {
              authProfile: request.authProfile,
              allowedOrigins: request.stage.input.allowedOrigins,
            }
          : {}),
        signal: sharedSignal,
        ...(this.id === "browser" && request.browserReadiness !== undefined
          ? { browserReadiness: request.browserReadiness }
          : {}),
        ...(cached === null || (cached.etag === undefined && cached.lastModified === undefined)
          ? {}
          : {
              revalidate: {
                url: request.url.toString(),
                ...(cached.etag === undefined ? {} : { etag: cached.etag }),
                ...(cached.lastModified === undefined
                  ? {}
                  : { lastModified: cached.lastModified }),
              },
            }),
        maxResponseBytes: request.maxResponseBytes,
        timeoutMs: request.timeoutMs,
      });
      page = this.id === "browser"
        ? await fetchPage(signal)
        : await this.cache.singleflight(
            `${request.cacheKey}:${request.stage.provider}:${request.stage.id}`,
            fetchPage,
            signal,
          );
      const durationMs = Math.max(0, performance.now() - startedAtMs);
      const usage: ResourceUsage = {
        ...zeroProviderUsage(),
        documentBytesIn: page.responseBytes,
        browserMilliseconds: this.id === "browser" ? durationMs : 0,
        browserContextStarts: this.id === "browser" ? 1 : 0,
      };
      if (page.notModified === true) {
        const artifact = this.cache.markRevalidated(request.cacheKey, {
          ...(page.etag === undefined ? {} : { etag: page.etag }),
          ...(page.lastModified === undefined ? {} : { lastModified: page.lastModified }),
        });
        if (cached === null || artifact === null) {
          throw new ReadError(
            "UPSTREAM_ERROR",
            "The origin returned 304 but no cached artifact is available.",
          );
        }
        return Object.freeze({
          stageId: request.stage.id,
          providerVersion: this.capabilities().version,
          outcome: "succeeded" as const,
          rawRef: cached.rawRef,
          traceRef: null,
          candidateArtifactRef: cached.artifactKey,
          candidate: {
            kind: "artifact" as const,
            artifact: {
              ...artifact,
              cached: true,
              evidence: {
                ...artifact.evidence,
                httpStatus: 304,
                responseBytes: 0,
                cacheStatus: "revalidated" as const,
              },
            },
          },
          error: null,
          usage,
          startedAt,
          completedAt: new Date().toISOString(),
        });
      }
      rawRef = this.cache.storeRaw(page, request.intent);
      if (this.id === "feed" && !isFeed(page)) {
        throw new ReadError("UNSUPPORTED_CONTENT_TYPE", "The feed provider received non-feed content.");
      }
      if (this.id === "pdf" && !isPdf(page)) {
        throw new ReadError("UNSUPPORTED_CONTENT_TYPE", "The PDF provider received non-PDF content.");
      }
      return Object.freeze({
        stageId: request.stage.id,
        providerVersion: this.capabilities().version,
        outcome: "succeeded" as const,
        rawRef,
        traceRef: null,
        candidateArtifactRef: null,
        candidate: { kind: "raw" as const, page: Object.freeze({ ...page }) },
        error: null,
        usage,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const normalized = signal.aborted
        ? new ReadError("CRAWL_CANCELLED", "The provider stage was cancelled.")
        : normalizeError(error);
      observationError = normalized;
      const durationMs = Math.max(0, performance.now() - startedAtMs);
      return providerFailureResult(
        request.stage.id,
        this.capabilities().version,
        normalized,
        startedAt,
        normalized.code === "CRAWL_CANCELLED" ? "cancelled" : "failed",
        {
          ...zeroProviderUsage(),
          documentBytesIn: page?.responseBytes ?? 0,
          browserMilliseconds: this.id === "browser" ? durationMs : 0,
          browserContextStarts: this.id === "browser" ? 1 : 0,
        },
        rawRef,
      );
    } finally {
      await lease?.release({
        durationMs: Math.max(0, performance.now() - startedAtMs),
        error: observationError,
      });
    }
  }
}

export function createBuiltinProviderRegistry(
  cache: PageCache,
  httpFetcher: PageFetcher,
  browserFetcher: PageFetcher,
  resources: RuntimeResourceGovernor | null = null,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new CacheAccessProvider(cache));
  registry.register(new FetchAccessProvider("http", cache, httpFetcher, resources));
  registry.register(new FetchAccessProvider("browser", cache, browserFetcher, resources));
  registry.register(new FetchAccessProvider("feed", cache, httpFetcher, resources));
  registry.register(new FetchAccessProvider("pdf", cache, httpFetcher, resources));
  registry.declareUnavailable("adapter", "no adapter passed the ROI gate");
  return registry;
}
