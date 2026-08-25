import { createHash } from "node:crypto";

import { PageCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { extractPage } from "./extract.js";
import { ReadError } from "./errors.js";
import { LocalPageIndex } from "./index.js";
import type {
  InspectPageResult,
  PageReadArtifact,
  PageFetcher,
  ReadPageOptions,
  ReadPageResult,
} from "./types.js";
import { UrlPolicy } from "./security/url-policy.js";
import { validateContent } from "./validation.js";

function cacheKey(url: string, mode: string, authProfile: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ schema: 3, url, mode, authProfile }))
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

export class ReaderService {
  constructor(
    private readonly config: AppConfig,
    private readonly urlPolicy: UrlPolicy,
    private readonly cache: PageCache,
    private readonly httpFetcher: PageFetcher,
    private readonly browserFetcher: PageFetcher,
    private readonly localIndex: LocalPageIndex | null = null,
  ) {}

  async readPage(options: ReadPageOptions): Promise<ReadPageResult> {
    return withoutLinks(await this.readPageArtifact(options));
  }

  async readPageArtifact(options: ReadPageOptions): Promise<PageReadArtifact> {
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

    const url = this.urlPolicy.parse(options.url);
    await this.urlPolicy.assertPublic(url);
    const authProfile = options.authProfile ?? null;
    const key = cacheKey(url.toString(), mode, authProfile);

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

    let result: PageReadArtifact;
    if (mode === "http") {
      result = await this.fetchAndExtract(url, this.httpFetcher, null);
    } else if (mode === "browser" || authProfile !== null) {
      result = await this.fetchAndExtract(url, this.browserFetcher, authProfile);
    } else {
      try {
        result = await this.fetchAndExtract(url, this.httpFetcher, null);
      } catch (error) {
        if (
          !(error instanceof ReadError) ||
          (error.code !== "SHELL_ONLY" && error.code !== "INCOMPLETE_CONTENT")
        ) {
          throw error;
        }
        try {
          result = await this.fetchAndExtract(url, this.browserFetcher, null);
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

    this.cache.put(key, result);
    this.localIndex?.put(result);
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
    authProfile: string | null,
  ): Promise<PageReadArtifact> {
    const page = await fetcher.fetch(sourceUrl, authProfile ?? undefined);
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
      },
    };
  }
}
