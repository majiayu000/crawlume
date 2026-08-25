import { BrowserPageFetcher } from "./fetch/browser.js";
import { HttpPageFetcher, HttpTransport } from "./fetch/http.js";
import { PageCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { CrawlRequestPolicy } from "./crawl-policy.js";
import { LocalPageIndex } from "./index.js";
import { CrawlJobService, CrawlJobStore } from "./jobs.js";
import { CrawlerMetrics } from "./metrics.js";
import { ProxyPool } from "./proxy.js";
import { ProfileManager } from "./profiles.js";
import { ReaderService } from "./reader.js";
import { RobotsPolicy } from "./security/robots.js";
import { UrlPolicy } from "./security/url-policy.js";
import { SiteService } from "./site.js";
import { SearchService, SearxngProvider } from "./search.js";

export type DiaoyanApp = {
  reader: ReaderService;
  profiles: ProfileManager;
  site: SiteService;
  jobs: CrawlJobService;
  search: SearchService;
  metrics: CrawlerMetrics;
  close(): Promise<void>;
};

export function createApp(
  config: AppConfig,
  options: { runCrawlWorker?: boolean } = {},
): DiaoyanApp {
  const urlPolicy = new UrlPolicy(undefined, config.allowDnsFakeIp);
  const proxyPool = new ProxyPool(config.proxyEndpoints);
  const transport = new HttpTransport(config, urlPolicy, proxyPool);
  const robots = new RobotsPolicy(config, transport);
  const profiles = new ProfileManager(config);
  const cache = new PageCache(config.cachePath);
  const metrics = new CrawlerMetrics(config.cachePath);
  const localIndex = config.localIndexEnabled ? new LocalPageIndex(config.cachePath) : null;
  const crawlPolicy = new CrawlRequestPolicy(config);
  const httpFetcher = new HttpPageFetcher(transport, robots);
  const browserFetcher = new BrowserPageFetcher(config, urlPolicy, robots, profiles, proxyPool);
  const reader = new ReaderService(
    config,
    urlPolicy,
    cache,
    httpFetcher,
    browserFetcher,
    localIndex,
    crawlPolicy,
    metrics,
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

  return {
    reader,
    profiles,
    site,
    jobs,
    search,
    metrics,
    async close(): Promise<void> {
      await jobs.close();
      await browserFetcher.close();
      reader.close();
      localIndex?.close();
      metrics.close();
      await transport.close();
    },
  };
}
