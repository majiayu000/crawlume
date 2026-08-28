import { extractLinks } from "./extract.js";
import { CrawlRequestPolicy } from "./crawl-policy.js";
import { normalizeError, ReadError } from "./errors.js";
import type { ReaderService } from "./reader.js";
import type { UrlPolicy } from "./security/url-policy.js";
import type {
  CrawlSiteOptions,
  CrawlSiteResult,
  DiscoveredUrl,
  MapSiteOptions,
  MapSiteResult,
  PageFetcher,
  RawPage,
  SiteFailure,
} from "./types.js";

const defaultMapPages = 50;
const maximumMapPages = 500;
const defaultCrawlPages = 10;
const maximumCrawlPages = 50;
const defaultDepth = 2;
const maximumDepth = 10;

type QueueEntry = DiscoveredUrl;

type Scope = {
  hostname: string;
  includeSubdomains: boolean;
  ignoreQueryParameters: boolean;
};

type CrawlExecutionOptions = CrawlSiteOptions & { signal?: AbortSignal };

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ReadError("CRAWL_CANCELLED", "The crawl job was cancelled.");
  }
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between 1 and ${maximum}.`,
      { details: { name, value: resolved, maximum } },
    );
  }
  return resolved;
}

function depthValue(value: number | undefined): number {
  const resolved = value ?? defaultDepth;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximumDepth) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      `maxDepth must be an integer between 0 and ${maximumDepth}.`,
      { details: { name: "maxDepth", value: resolved, maximum: maximumDepth } },
    );
  }
  return resolved;
}

function normalizeCandidate(rawUrl: string, scope: Scope): string | null {
  if (!URL.canParse(rawUrl)) {
    return null;
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const inScope =
    url.hostname === scope.hostname ||
    (scope.includeSubdomains && url.hostname.endsWith(`.${scope.hostname}`));
  if (!inScope) {
    return null;
  }
  url.hash = "";
  if (scope.ignoreQueryParameters) {
    url.search = "";
  }
  return url.toString();
}

function toFailure(entry: QueueEntry, error: unknown): SiteFailure {
  const normalized = normalizeError(error);
  return {
    ...entry,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    details: normalized.details,
  };
}

function shouldRender(page: RawPage, links: string[]): boolean {
  if (!page.contentType.toLowerCase().includes("html") || links.length > 0) {
    return false;
  }
  const text = page.body.toLowerCase();
  return (
    /enable javascript|javascript is disabled|loading(?:\.{3}|…)|something went wrong/.test(text) ||
    (page.body.length < 4_000 && (page.body.match(/<script\b/gi)?.length ?? 0) > 3)
  );
}

export class SiteService {
  constructor(
    private readonly urlPolicy: UrlPolicy,
    private readonly reader: ReaderService,
    private readonly httpFetcher: PageFetcher,
    private readonly browserFetcher: PageFetcher,
    private readonly crawlPolicy: CrawlRequestPolicy | null = null,
  ) {}

  async mapSite(options: MapSiteOptions): Promise<MapSiteResult> {
    const maxPages = positiveInteger(options.maxPages, defaultMapPages, maximumMapPages, "maxPages");
    const maxDepth = depthValue(options.maxDepth);
    const mode = options.mode ?? "auto";
    if (options.authProfile !== undefined && mode === "http") {
      throw new ReadError("INVALID_ARGUMENT", "authProfile requires auto or browser mode.", {
        details: { mode },
      });
    }

    const root = this.urlPolicy.parse(options.url);
    await this.urlPolicy.assertPublic(root);
    const scope: Scope = {
      hostname: root.hostname,
      includeSubdomains: options.includeSubdomains ?? false,
      ignoreQueryParameters: options.ignoreQueryParameters ?? true,
    };
    const sourceUrl = normalizeCandidate(root.toString(), scope) ?? root.toString();
    const startedAt = new Date().toISOString();
    const queue: QueueEntry[] = [{ url: sourceUrl, depth: 0, discoveredFrom: null }];
    const queued = new Set([sourceUrl]);
    const urls: DiscoveredUrl[] = [];
    const failures: SiteFailure[] = [];
    let scannedPages = 0;

    while (queue.length > 0 && scannedPages < maxPages) {
      const entry = queue.shift();
      if (entry === undefined) {
        break;
      }
      scannedPages += 1;
      try {
        const page = await this.fetchForMap(new URL(entry.url), mode, options.authProfile);
        urls.push(entry);
        if (entry.depth >= maxDepth) {
          continue;
        }
        this.enqueueLinks(
          extractLinks(page.body, page.finalUrl),
          entry,
          scope,
          queued,
          queue,
        );
      } catch (error) {
        if (entry.depth === 0) {
          throw error;
        }
        failures.push(toFailure(entry, error));
      }
    }

    return {
      status: failures.length === 0 ? "ok" : "partial",
      sourceUrl,
      startedAt,
      completedAt: new Date().toISOString(),
      scannedPages,
      urls,
      failures,
      truncated: queue.length > 0,
    };
  }

  async crawlSite(options: CrawlExecutionOptions): Promise<CrawlSiteResult> {
    const maxPages = positiveInteger(
      options.maxPages,
      defaultCrawlPages,
      maximumCrawlPages,
      "maxPages",
    );
    const maxDepth = depthValue(options.maxDepth);
    const root = this.urlPolicy.parse(options.url);
    await this.urlPolicy.assertPublic(root);
    const scope: Scope = {
      hostname: root.hostname,
      includeSubdomains: options.includeSubdomains ?? false,
      ignoreQueryParameters: options.ignoreQueryParameters ?? true,
    };
    const sourceUrl = normalizeCandidate(root.toString(), scope) ?? root.toString();
    const startedAt = new Date().toISOString();
    const queue: QueueEntry[] = [{ url: sourceUrl, depth: 0, discoveredFrom: null }];
    const queued = new Set([sourceUrl]);
    const pages: CrawlSiteResult["pages"] = [];
    const failures: SiteFailure[] = [];
    let scannedPages = 0;

    while (queue.length > 0 && scannedPages < maxPages) {
      throwIfCancelled(options.signal);
      const entry = queue.shift();
      if (entry === undefined) {
        break;
      }
      scannedPages += 1;
      try {
        const artifact = await this.reader.readPageArtifact({
          url: entry.url,
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.cacheMode === undefined ? {} : { cacheMode: options.cacheMode }),
          ...(options.maxAgeSeconds === undefined
            ? {}
            : { maxAgeSeconds: options.maxAgeSeconds }),
          ...(options.authProfile === undefined ? {} : { authProfile: options.authProfile }),
          ...(options.browserReadiness === undefined
            ? {}
            : { browserReadiness: options.browserReadiness }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        throwIfCancelled(options.signal);
        const { discoveredLinks, ...result } = artifact;
        pages.push({ ...entry, result });
        if (entry.depth >= maxDepth) {
          continue;
        }
        this.enqueueLinks(discoveredLinks, entry, scope, queued, queue);
      } catch (error) {
        throwIfCancelled(options.signal);
        if (entry.depth === 0) {
          throw error;
        }
        failures.push(toFailure(entry, error));
      }
    }

    return {
      status: failures.length === 0 ? "ok" : "partial",
      sourceUrl,
      startedAt,
      completedAt: new Date().toISOString(),
      scannedPages,
      pages,
      failures,
      truncated: queue.length > 0,
    };
  }

  private async fetchForMap(
    url: URL,
    mode: "auto" | "http" | "browser",
    authProfile: string | undefined,
  ): Promise<RawPage> {
    const operation = async (): Promise<RawPage> =>
      this.fetchForMapOnce(url, mode, authProfile);
    return this.crawlPolicy === null
      ? operation()
      : (await this.crawlPolicy.execute(url, operation)).value;
  }

  private async fetchForMapOnce(
    url: URL,
    mode: "auto" | "http" | "browser",
    authProfile: string | undefined,
  ): Promise<RawPage> {
    if (mode === "browser" || authProfile !== undefined) {
      return this.browserFetcher.fetch(
        url,
        authProfile === undefined ? {} : { authProfile },
      );
    }
    const page = await this.httpFetcher.fetch(url);
    const links = extractLinks(page.body, page.finalUrl);
    if (mode === "auto" && shouldRender(page, links)) {
      return this.browserFetcher.fetch(url, {});
    }
    return page;
  }

  private enqueueLinks(
    links: string[],
    parent: QueueEntry,
    scope: Scope,
    queued: Set<string>,
    queue: QueueEntry[],
  ): void {
    for (const rawUrl of links) {
      const url = normalizeCandidate(rawUrl, scope);
      if (url === null || queued.has(url)) {
        continue;
      }
      queued.add(url);
      queue.push({ url, depth: parent.depth + 1, discoveredFrom: parent.url });
    }
  }
}
