import { normalizeError, ReadError } from "./errors.js";
import type { ReaderService } from "./reader.js";
import type { UrlPolicy } from "./security/url-policy.js";
import {
  createSiteScope,
  normalizeDiscoveredLink,
  siteSourceUrl,
  type SiteScope,
} from "./site-scope.js";
import type {
  CrawlSiteOptions,
  CrawlSiteResult,
  DiscoveredUrl,
  MapSiteOptions,
  MapSiteResult,
  SiteFailure,
} from "./types.js";

const defaultMapPages = 50;
const maximumMapPages = 500;
const defaultCrawlPages = 10;
const maximumCrawlPages = 50;
const defaultDepth = 2;
const maximumDepth = 10;

type QueueEntry = DiscoveredUrl;

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

export class SiteService {
  constructor(
    private readonly urlPolicy: UrlPolicy,
    private readonly reader: ReaderService,
  ) {}

  async mapSite(options: MapSiteOptions): Promise<MapSiteResult> {
    const maxPages = positiveInteger(options.maxPages, defaultMapPages, maximumMapPages, "maxPages");
    const maxDepth = depthValue(options.maxDepth);
    const browserAllowed = options.browserAllowed ?? true;
    if (options.authProfile !== undefined && !browserAllowed) {
      throw new ReadError("INVALID_ARGUMENT", "authProfile requires browser access.");
    }

    const root = this.urlPolicy.parse(options.url);
    const scope = createSiteScope(root, options);
    const sourceUrl = siteSourceUrl(root, scope);
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
        const page = await this.reader.discoverPageArtifact({
          url: entry.url,
          browserAllowed,
          cacheMode: "live",
          ...(options.authProfile === undefined ? {} : { authProfile: options.authProfile }),
          ...(options.budget === undefined ? {} : { budget: options.budget }),
        });
        urls.push(entry);
        if (entry.depth >= maxDepth) {
          continue;
        }
        this.enqueueLinks(
          page.discoveredLinks,
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
    const scope = createSiteScope(root, options);
    const sourceUrl = siteSourceUrl(root, scope);
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
        const artifact = await this.reader.crawlPageArtifact({
          url: entry.url,
          ...(options.browserAllowed === undefined
            ? {}
            : { browserAllowed: options.browserAllowed }),
          ...(options.cacheMode === undefined ? {} : { cacheMode: options.cacheMode }),
          ...(options.maxAgeSeconds === undefined
            ? {}
            : { maxAgeSeconds: options.maxAgeSeconds }),
          ...(options.authProfile === undefined ? {} : { authProfile: options.authProfile }),
          ...(options.browserReadiness === undefined
            ? {}
            : { browserReadiness: options.browserReadiness }),
          ...(options.budget === undefined ? {} : { budget: options.budget }),
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

  private enqueueLinks(
    links: string[],
    parent: QueueEntry,
    scope: SiteScope,
    queued: Set<string>,
    queue: QueueEntry[],
  ): void {
    for (const rawUrl of links) {
      const discovered = normalizeDiscoveredLink(rawUrl, parent, scope);
      if (discovered === null || queued.has(discovered.url)) {
        continue;
      }
      queued.add(discovered.url);
      queue.push(discovered);
    }
  }
}
