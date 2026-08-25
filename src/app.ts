import { BrowserPageFetcher } from "./fetch/browser.js";
import { HttpPageFetcher, HttpTransport } from "./fetch/http.js";
import { PageCache } from "./cache.js";
import type { AppConfig } from "./config.js";
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
  search: SearchService;
  close(): Promise<void>;
};

export function createApp(config: AppConfig): DiaoyanApp {
  const urlPolicy = new UrlPolicy(undefined, config.allowDnsFakeIp);
  const transport = new HttpTransport(config, urlPolicy);
  const robots = new RobotsPolicy(config, transport);
  const profiles = new ProfileManager(config);
  const cache = new PageCache(config.cachePath);
  const httpFetcher = new HttpPageFetcher(transport, robots);
  const browserFetcher = new BrowserPageFetcher(config, urlPolicy, robots, profiles);
  const reader = new ReaderService(config, urlPolicy, cache, httpFetcher, browserFetcher);
  const site = new SiteService(urlPolicy, reader, httpFetcher, browserFetcher);
  const searchProvider = config.searxngUrl === null
    ? null
    : new SearxngProvider(
        config.searxngUrl,
        config.userAgent,
        config.requestTimeoutMs,
      );
  const search = new SearchService(searchProvider);

  return {
    reader,
    profiles,
    site,
    search,
    async close(): Promise<void> {
      reader.close();
      await transport.close();
    },
  };
}
