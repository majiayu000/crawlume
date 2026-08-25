export const fetchModes = ["auto", "http", "browser"] as const;
export type FetchMode = (typeof fetchModes)[number];

export const cacheModes = ["prefer-cache", "live", "cache-only"] as const;
export type CacheMode = (typeof cacheModes)[number];

export const searchTimeRanges = ["day", "month", "year"] as const;
export type SearchTimeRange = (typeof searchTimeRanges)[number];

export const searchSources = ["auto", "local", "web"] as const;
export type SearchSource = (typeof searchSources)[number];

export type FetchMethod = "http" | "browser";
export type ExtractionMethod = "readability" | "document" | "plain";
export type ContentStatus = "usable" | "uncertain";
export type ContentWarningCode = "SHORT_CONTENT" | "FALLBACK_EXTRACTION";

export type ContentValidation = {
  status: ContentStatus;
  warnings: Array<{
    code: ContentWarningCode;
    message: string;
  }>;
};

export type AgentIdentityEvidence = {
  userAgent: string;
  identityUrl: string | null;
  signed: boolean;
  profile: "cloudflare-legacy" | null;
};

export type ReadPageOptions = {
  url: string;
  mode?: FetchMode;
  cacheMode?: CacheMode;
  maxAgeSeconds?: number;
  authProfile?: string;
};

export type FetchEvidence = {
  httpStatus: number;
  contentType: string;
  responseBytes: number;
  finalUrl: string;
  proxyUsed?: boolean;
  agentIdentity?: AgentIdentityEvidence;
};

export type RawPage = FetchEvidence & {
  body: string;
  fetchedAt: string;
  method: FetchMethod;
};

export type ExtractedPage = {
  title: string;
  byline: string | null;
  publishedTime: string | null;
  markdown: string;
  contentCharacters: number;
  contentHash: string;
  extractionMethod: ExtractionMethod;
  links: string[];
};

export type ReadPageResult = {
  status: "ok";
  sourceUrl: string;
  finalUrl: string;
  fetchedAt: string;
  fetchMethod: FetchMethod;
  authProfile: string | null;
  cached: boolean;
  title: string;
  byline: string | null;
  publishedTime: string | null;
  contentMarkdown: string;
  contentHash: string;
  completeness: "complete";
  validation: ContentValidation;
  evidence: {
    httpStatus: number;
    contentType: string;
    responseBytes: number;
    contentCharacters: number;
    extractionMethod: ExtractionMethod;
    attempts?: number;
    totalRetryDelayMs?: number;
    proxyUsed?: boolean;
    agentIdentity?: AgentIdentityEvidence;
  };
};

export type InspectPageResult = Omit<ReadPageResult, "contentMarkdown">;

export type PageReadArtifact = ReadPageResult & {
  discoveredLinks: string[];
};

export type SiteScopeOptions = {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
};

export type MapSiteOptions = SiteScopeOptions & {
  mode?: FetchMode;
  authProfile?: string;
};

export type CrawlSiteOptions = SiteScopeOptions & Omit<ReadPageOptions, "url">;

export type DiscoveredUrl = {
  url: string;
  depth: number;
  discoveredFrom: string | null;
};

export type SiteFailure = DiscoveredUrl & {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, boolean | number | string | null>;
};

export type MapSiteResult = {
  status: "ok" | "partial";
  sourceUrl: string;
  startedAt: string;
  completedAt: string;
  scannedPages: number;
  urls: DiscoveredUrl[];
  failures: SiteFailure[];
  truncated: boolean;
};

export type CrawledPage = DiscoveredUrl & {
  result: ReadPageResult;
};

export type CrawlSiteResult = {
  status: "ok" | "partial";
  sourceUrl: string;
  startedAt: string;
  completedAt: string;
  scannedPages: number;
  pages: CrawledPage[];
  failures: SiteFailure[];
  truncated: boolean;
};

export const crawlJobStatuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type CrawlJobStatus = (typeof crawlJobStatuses)[number];

export type CrawlJobError = {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, boolean | number | string | null>;
};

export type CrawlJob = {
  id: string;
  status: CrawlJobStatus;
  input: CrawlSiteOptions;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: CrawlSiteResult | null;
  error: CrawlJobError | null;
};

export type SearchWebOptions = {
  query: string;
  limit?: number;
  page?: number;
  language?: string;
  safeSearch?: 0 | 1 | 2;
  timeRange?: SearchTimeRange;
  source?: SearchSource;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: "local" | "web";
  engines: string[];
  score: number | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
};

export type SearchWarning = {
  code: string;
  message: string;
  retryable: boolean;
};

export type SearchWebResult = {
  status: "ok" | "partial";
  query: string;
  provider: string;
  searchedAt: string;
  page: number;
  results: SearchResult[];
  totalResults: number | null;
  warnings: SearchWarning[];
};

export type CrawlerStatsDay = {
  date: string;
  requests: number;
  successes: number;
  failures: number;
  cacheHits: number;
  responseBytes: number;
  durationMs: number;
};

export type CrawlerStatsResult = {
  status: "ok";
  generatedAt: string;
  since: string;
  days: number;
  totals: {
    requests: number;
    successes: number;
    failures: number;
    successRate: number | null;
    cacheHits: number;
    cacheHitRate: number | null;
  };
  fetchMethods: {
    http: number;
    browser: number;
  };
  cost: {
    responseBytes: number;
    contentCharacters: number;
    attempts: number;
    retryDelayMs: number;
    durationMs: number;
  };
  failureReasons: Array<{
    code: string;
    count: number;
  }>;
  daily: CrawlerStatsDay[];
};

export const pageMonitorStatuses = ["scheduled", "running", "cancelled"] as const;
export type PageMonitorStatus = (typeof pageMonitorStatuses)[number];

export type PageMonitorInput = {
  url: string;
  mode?: FetchMode;
  authProfile?: string;
};

export type PageMonitorSuccessRun = {
  status: "ok";
  startedAt: string;
  completedAt: string;
  changed: boolean | null;
  previousContentHash: string | null;
  contentHash: string;
  page: InspectPageResult;
};

export type PageMonitorFailureRun = {
  status: "error";
  startedAt: string;
  completedAt: string;
  error: CrawlJobError;
};

export type PageMonitorRun = PageMonitorSuccessRun | PageMonitorFailureRun;

export type PageMonitor = {
  id: string;
  status: PageMonitorStatus;
  input: PageMonitorInput;
  intervalSeconds: number;
  createdAt: string;
  startedAt: string | null;
  nextRunAt: string | null;
  lastContentHash: string | null;
  lastChangedAt: string | null;
  runCount: number;
  changeCount: number;
  failureCount: number;
  lastRun: PageMonitorRun | null;
};

export interface PageFetcher {
  fetch(url: URL, authProfile?: string, signal?: AbortSignal): Promise<RawPage>;
}
