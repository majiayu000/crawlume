import { BrowserPageFetcher } from "./fetch/browser.js";
import { HttpPageFetcher, HttpTransport } from "./fetch/http.js";
import { PageCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { CrawlRequestPolicy } from "./crawl-policy.js";
import { LocalPageIndex } from "./index.js";
import { CrawlJobService, CrawlJobStore } from "./jobs.js";
import { CrawlerMetrics } from "./metrics.js";
import { PageMonitorService, PageMonitorStore } from "./monitors.js";
import { ProxyPool } from "./proxy.js";
import { ProfileManager } from "./profiles.js";
import { ReaderService } from "./reader.js";
import { RobotsPolicy } from "./security/robots.js";
import { UrlPolicy } from "./security/url-policy.js";
import { SiteService } from "./site.js";
import { SearchService, SearxngProvider } from "./search.js";
import { RslPolicy } from "./rsl.js";
import { RslAccessAudit } from "./rsl-audit.js";

export type DiaoyanApp = {
  reader: ReaderService;
  profiles: ProfileManager;
  site: SiteService;
  jobs: CrawlJobService;
  search: SearchService;
  metrics: CrawlerMetrics;
  monitors: PageMonitorService;
  rslAudit: RslAccessAudit;
  close(): Promise<void>;
};

async function captureClose(
  operation: () => void | Promise<void>,
  failures: unknown[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

export function createApp(
  config: AppConfig,
  options: { runCrawlWorker?: boolean; runMonitorWorker?: boolean } = {},
): DiaoyanApp {
  const urlPolicy = new UrlPolicy(undefined, config.allowDnsFakeIp);
  const proxyPool = new ProxyPool(config.proxyEndpoints);
  const transport = new HttpTransport(config, urlPolicy, proxyPool);
  const robots = new RobotsPolicy(config, transport);
  const rsl = new RslPolicy(config, transport);
  const profiles = new ProfileManager(config);
  const cache = new PageCache(config.cachePath);
  const metrics = new CrawlerMetrics(config.cachePath);
  const rslAudit = new RslAccessAudit(config.cachePath, config.rslUsage);
  const localIndex = config.localIndexEnabled ? new LocalPageIndex(config.cachePath) : null;
  const crawlPolicy = new CrawlRequestPolicy(config);
  const httpFetcher = new HttpPageFetcher(transport, robots, rsl);
  const browserFetcher = new BrowserPageFetcher(config, urlPolicy, robots, profiles, rsl, proxyPool);
  const reader = new ReaderService(
    config,
    urlPolicy,
    cache,
    httpFetcher,
    browserFetcher,
    localIndex,
    crawlPolicy,
    metrics,
    rslAudit,
    () => rsl.approvalContextHash,
  );
  const site = new SiteService(urlPolicy, reader, httpFetcher, browserFetcher, crawlPolicy);
  const searchProvider = config.searxngUrl === null
    ? null
    : new SearxngProvider(
        config.searxngUrl,
        config.userAgent,
        config.requestTimeoutMs,
      );
  const search = new SearchService(searchProvider, localIndex);
  const jobs = new CrawlJobService(
    new CrawlJobStore(config.cachePath),
    site,
    options.runCrawlWorker ?? true,
  );
  const monitors = new PageMonitorService(
    new PageMonitorStore(config.cachePath),
    reader,
    urlPolicy,
    options.runMonitorWorker ?? options.runCrawlWorker ?? true,
  );

  return {
    reader,
    profiles,
    site,
    jobs,
    search,
    metrics,
    monitors,
    rslAudit,
    async close(): Promise<void> {
      const failures: unknown[] = [];
      const workerResults = await Promise.allSettled([jobs.close(), monitors.close()]);
      for (const result of workerResults) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      await captureClose(async () => browserFetcher.close(), failures);
      await captureClose(() => reader.close(), failures);
      await captureClose(() => localIndex?.close(), failures);
      await captureClose(() => metrics.close(), failures);
      await captureClose(() => rslAudit.close(), failures);
      await captureClose(async () => transport.close(), failures);
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Multiple crawler resources failed to close.");
      }
    },
  };
}
