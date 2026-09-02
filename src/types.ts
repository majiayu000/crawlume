import type { ReadErrorCode, ReadErrorDetails } from "./errors.js";

export const cacheModes = ["prefer-cache", "live", "cache-only"] as const;
export type CacheMode = (typeof cacheModes)[number];

export const searchTimeRanges = ["day", "month", "year"] as const;
export type SearchTimeRange = (typeof searchTimeRanges)[number];

export const searchSources = ["auto", "local", "web"] as const;
export type SearchSource = (typeof searchSources)[number];

export type FetchMethod = "http" | "browser";
export type ExtractionMethod =
  | "json"
  | "json-ld"
  | "rss"
  | "atom"
  | "sitemap"
  | "pdf"
  | "readability"
  | "document"
  | "plain";
export const accessProviderIds = ["cache", "http", "browser", "feed", "pdf", "adapter"] as const;
export type AccessProviderId = (typeof accessProviderIds)[number];

export type ExecutionBudget = {
  deadlineMs: number;
  maxAttempts: number;
  maxDocumentBytes: number;
  maxBrowserMs: number;
  maxBrowserContexts: number;
  maxOptionalModelTokens: number;
};

export type ReadCompletion =
  | { type: "content" }
  | { type: "discovery" }
  | { type: "dom"; readiness: BrowserReadinessPolicy };

export type PlanningFacts = {
  cachePolicy: CacheMode;
  providers: {
    cache: boolean;
    http: boolean;
    browser: boolean;
  };
};

export type ReadIntent = {
  url: string;
  operation: "read" | "inspect" | "map" | "crawl" | "extract";
  output: { format: "markdown" | "json"; schemaId?: string };
  freshness: {
    maxAgeSeconds: number;
    allowStaleWhileRevalidate: boolean;
    staleWhileRevalidateSeconds?: number;
  };
  authorization: { profileId: string | null; allowedOrigins: string[] };
  completion: ReadCompletion;
  budget: ExecutionBudget;
};

export type StagePredicate =
  | { type: "always" }
  | { type: "after-invalid"; stageId: string }
  | { type: "after-failure"; stageId: string; errorCodes: ReadErrorCode[] };

export type StageRetryPolicy = {
  maxAttempts: number;
  retryableErrorCodes: ReadErrorCode[];
};

export type PlannedStageReasonCode =
  | "CACHE_ONLY"
  | "CACHE_PREFERRED"
  | "HTTP_PRIMARY"
  | "BROWSER_PRIMARY_HTTP_UNAVAILABLE"
  | "BROWSER_REQUIRED_BY_AUTHORIZATION"
  | "BROWSER_REQUIRED_BY_COMPLETION"
  | "BROWSER_AFTER_INCOMPLETE_HTTP";

export type PlannedStageInput = {
  url: string;
  operation: ReadIntent["operation"];
  authorizationProfileId: string | null;
  allowedOrigins: string[];
  completion: ReadCompletion;
};

export type PlannedStage = {
  id: string;
  provider: AccessProviderId;
  reasonCode: PlannedStageReasonCode;
  input: PlannedStageInput;
  runWhen: StagePredicate;
  retryPolicy: StageRetryPolicy;
  budgetSlice: ExecutionBudget;
};

export type AccessPlan = {
  id: string;
  plannerVersion: string;
  stages: PlannedStage[];
  terminalConditions: Array<"valid-artifact" | "policy-stop" | "budget-exhausted">;
};

export type AccessPlanEvidence = {
  planId: string;
  plannerVersion: string;
  plannedStages: Array<{
    stageId: string;
    provider: AccessProviderId;
    reasonCode: PlannedStageReasonCode;
  }>;
  executedStages: string[];
};

export type ResourceUsage = {
  documentBytesIn: number;
  networkBytesOut: number;
  browserMilliseconds: number;
  browserContextStarts: number;
  retryDelayMilliseconds: number;
  optionalModelTokens: number;
};

export type StageResult = {
  stageId: string;
  outcome: "succeeded" | "failed" | "stopped" | "cancelled";
  rawRef: string | null;
  traceRef: string | null;
  candidateArtifactRef: string | null;
  error: {
    code: ReadErrorCode;
    message: string;
    retryable: boolean;
    details: ReadErrorDetails;
  } | null;
  usage: ResourceUsage;
  startedAt: string;
  completedAt: string;
};

export type ValidationResult = {
  outcome: "valid" | "uncertain" | "invalid";
  validatorVersion: string;
  checks: Array<{ code: string; passed: boolean | null; message: string }>;
  terminalError: { code: ReadErrorCode; message: string } | null;
};

export type AttemptInput = {
  requestId: string;
  planId: string;
  stageId: string;
  provider: AccessProviderId;
  providerVersion: string;
  outcome: StageResult["outcome"];
  rawRef: string | null;
  traceRef: string | null;
  errorCode: ReadErrorCode | null;
  usage: ResourceUsage;
  startedAt: string;
  completedAt: string;
};

export type AttemptRecord = AttemptInput & {
  id: string;
  sequence: number;
  recordedAt: string;
};

export type RequestTerminalState =
  | "completed"
  | "completed_uncertain"
  | "invalid"
  | "failed"
  | "policy_stop"
  | "budget_exhausted"
  | "cancelled";

export type RequestTerminalError = {
  code: ReadErrorCode;
  message: string;
  retryable: boolean;
  details: ReadErrorDetails;
};

export type RequestTerminalInput = {
  requestId: string;
  planId: string;
  state: RequestTerminalState;
  artifactKey: string | null;
  contentHash: string | null;
  validatorVersion: string | null;
  error: RequestTerminalError | null;
};

export type RequestTerminalProjection = RequestTerminalInput & {
  publicationKey: string | null;
  committedAt: string;
};

export type AttemptProjection = {
  requestId: string;
  attempts: number;
  lastSequence: number;
  lastOutcome: AttemptRecord["outcome"];
  lastStageId: string;
  usage: ResourceUsage;
  terminal: RequestTerminalProjection | null;
};

export type AgentIdentityEvidence = {
  userAgent: string;
  identityUrl: string | null;
  signed: boolean;
  profile: "cloudflare-legacy" | null;
};

export type BrowserReadinessTarget = {
  selector: string;
  state?: "attached" | "visible" | undefined;
  minCount?: number | undefined;
};

export type BrowserScrollInteraction = {
  type: "scroll-to-end";
  maxSteps: number;
  stepDelayMs?: number | undefined;
};

export type BrowserReadinessPolicy = {
  target: BrowserReadinessTarget;
  interaction?: BrowserScrollInteraction | undefined;
  timeoutMs?: number | undefined;
};

export type BrowserReadinessEvidence = {
  policy: "generic" | "target";
  waitedMs: number;
  reason: "meaningful-content-stable" | "short-page-grace-elapsed" | "target-condition-met";
  textCharacters: number;
  targetMatches?: number | undefined;
  interaction?: BrowserScrollInteraction["type"] | undefined;
  interactionSteps?: number | undefined;
};

export type RslDiscoveryMethod = "robots" | "http-link" | "html-link" | "html-inline";

export type RslEvidence = {
  status: "not-declared" | "not-applicable" | "permitted";
  usage: import("./config.js").RslUsage;
  discoveredBy: RslDiscoveryMethod[];
  licenseUrls: string[];
  licenseHashes: string[];
  approvalsApplied: number;
  licenseTokensApplied: number;
};

export type RslAccessAuditEntry = {
  id: number;
  occurredAt: string;
  requestUrl: string | null;
  finalUrl: string | null;
  outcome: "success" | "failure";
  errorCode: string | null;
  fetchMethod: FetchMethod | null;
  cached: boolean;
  rslStatus: RslEvidence["status"] | "blocked" | null;
  rslUsage: import("./config.js").RslUsage;
  licenseUrls: string[];
  licenseHashes: string[];
  approvalsApplied: number;
  licenseTokensApplied: number;
  payment: RslPaymentAudit | null;
};

export type RslPaymentAudit = {
  paymentType: string | null;
  paymentAmount: string | null;
  paymentCurrency: string | null;
  paymentProtocols: string[];
  pricingAuthority: "declared" | "runtime" | "unspecified";
  budgetStatus: "disabled";
  settlementStatus: "not-attempted";
};

export type RslAccessAuditResult = {
  status: "ok";
  generatedAt: string;
  entries: RslAccessAuditEntry[];
};

export type ReadPageOptions = {
  url: string;
  requestId?: string;
  cacheMode?: CacheMode;
  maxAgeSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  browserAllowed?: boolean;
  authProfile?: string;
  browserReadiness?: BrowserReadinessPolicy;
  budget?: ExecutionBudget;
};

export type FetchEvidence = {
  httpStatus: number;
  contentType: string;
  responseBytes: number;
  finalUrl: string;
  redirects?: UrlRedirect[];
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
  browserReadiness?: BrowserReadinessEvidence;
  proxyUsed?: boolean;
  agentIdentity?: AgentIdentityEvidence;
  rsl?: RslEvidence;
};

export type UrlRedirect = {
  fromUrl: string;
  toUrl: string;
  httpStatus: number | null;
};

export type RawPage = FetchEvidence & {
  body: string;
  bodyBytes?: Uint8Array;
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
  completeness: "complete" | "uncertain";
  validation: ValidationResult;
  evidence: {
    httpStatus: number;
    contentType: string;
    responseBytes: number;
      contentCharacters: number;
      extractionMethod: ExtractionMethod;
      extractorVersion: string;
      validatorVersion: string;
      cacheStatus?: "live" | "fresh" | "revalidated" | "stale" | "replayed";
    attempts?: number;
    retryAttempts?: number;
    totalRetryDelayMs?: number;
    fetchAttempts?: Record<FetchMethod, number>;
    responseBytesByMethod?: Record<FetchMethod, number>;
    fetchDurationMsByMethod?: Record<FetchMethod, number>;
    phaseDurationsMs?: { extraction: number; validation: number };
    requestId: string;
    accessPlan: AccessPlanEvidence;
    browserReadiness?: BrowserReadinessEvidence;
    proxyUsed?: boolean;
    agentIdentity?: AgentIdentityEvidence;
    rsl?: RslEvidence;
    urlIdentity?: {
      redirects: UrlRedirect[];
      declaredCanonicalUrl: string | null;
    };
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
  browserAllowed?: boolean;
  authProfile?: string;
  budget?: ExecutionBudget;
};

export type CrawlSiteOptions = SiteScopeOptions & Omit<ReadPageOptions, "url" | "requestId">;

export type CrawlBudget = {
  maxDurationMs: number;
  maxProviderAttempts: number;
  maxDocumentBytes: number;
  maxBrowserMs: number;
  maxBrowserContexts: number;
};

export type DurableCrawlOptions = CrawlSiteOptions & {
  concurrency?: number;
  crawlBudget?: CrawlBudget;
};

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
  "paused",
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

export type CrawlProgress = {
  discoveredCount: number;
  queuedCount: number;
  leasedCount: number;
  succeededCount: number;
  failedCount: number;
  stoppedCount: number;
  publishedCount: number;
};

export type CrawlResourceUsage = ResourceUsage & {
  providerAttempts: number;
};

export type CrawlTermination = {
  code: string;
  message: string;
  details: Record<string, boolean | number | string | null>;
};

export type CrawlJob = {
  id: string;
  status: CrawlJobStatus;
  input: DurableCrawlOptions;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: CrawlSiteResult | null;
  error: CrawlJobError | null;
  progress?: CrawlProgress;
  usage?: CrawlResourceUsage;
  budget?: CrawlBudget;
  termination?: CrawlTermination | null;
};

export type CrawlPagePublication = DiscoveredUrl & {
  publicationSequence: number;
  status: "succeeded" | "failed" | "stopped";
  result: ReadPageResult | null;
  error: CrawlJobError | null;
};

export type CrawlPageBatch = {
  jobId: string;
  pages: CrawlPagePublication[];
  nextSequence: number;
  done: boolean;
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

export type SearchQueryTrace = {
  correlationId: string;
  requestedSource: SearchSource;
  executedSources: Array<"local" | "web">;
  localSnapshot: {
    retrievalVersion: "local-fts5-v1";
    documents: number;
  } | null;
};

export type SearchServingResult = SearchWebResult & {
  trace: SearchQueryTrace;
};

export type SearchServingStatus = {
  status: "ready" | "unavailable";
  localIndexAvailable: boolean;
  localDocuments: number | null;
  webProvider: string | null;
  retrievalVersion: "local-fts5-v1" | null;
};

export type SearchServingStatsResult = {
  status: "ok";
  generatedAt: string;
  since: string;
  days: number;
  totals: {
    requests: number;
    ok: number;
    partial: number;
    failed: number;
    completeRate: number | null;
    usableRate: number | null;
  };
  latencyMs: {
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  requestedSources: Record<SearchSource, number>;
  executedSources: {
    local: number;
    web: number;
    hybrid: number;
    unobserved: number;
  };
  resultCount: number;
  warningCount: number;
  failureReasons: Array<{ code: string; count: number }>;
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
  finalStates: Record<RequestTerminalState, number>;
  cache: Record<"live" | "fresh" | "revalidated" | "stale" | "replayed", number>;
  versions: {
    planners: Array<{ version: string; count: number }>;
    providers: Array<{ provider: AccessProviderId; version: string; count: number }>;
    extractors: Array<{ version: string; count: number }>;
    validators: Array<{ version: string; count: number }>;
  };
  stages: Array<{
    stageId: string;
    provider: AccessProviderId;
    providerVersion: string;
    outcome: StageResult["outcome"];
    attempts: number;
    durationMs: number;
    resources: ResourceUsage;
  }>;
  resources: ResourceUsage;
  phaseDurationsMs: {
    provider: number;
    extraction: number;
    validation: number;
    endToEnd: number;
  };
  transitions: Array<{
    plannerVersion: string;
    stageId: string;
    provider: AccessProviderId;
    reasonCode: PlannedStageReasonCode;
    count: number;
  }>;
  crawlCoverage: {
    jobs: number;
    discoveredPages: number;
    publishedPages: number;
    succeededPages: number;
    failedPages: number;
    stoppedPages: number;
    coverageRate: number | null;
  };
  daily: CrawlerStatsDay[];
};

export const pageMonitorStatuses = ["scheduled", "running", "cancelled"] as const;
export type PageMonitorStatus = (typeof pageMonitorStatuses)[number];

export type PageMonitorInput = {
  url: string;
  browserAllowed?: boolean;
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

export type PageFetchOptions = {
  authProfile?: string;
  allowedOrigins?: string[];
  signal?: AbortSignal;
  browserReadiness?: BrowserReadinessPolicy;
  maxResponseBytes?: number;
  timeoutMs?: number;
  onNetworkRequestStart?: () => void;
  revalidate?: {
    url: string;
    etag?: string;
    lastModified?: string;
  };
};

export interface PageFetcher {
  fetch(url: URL, options?: PageFetchOptions): Promise<RawPage>;
}
