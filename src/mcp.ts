import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DiaoyanApp } from "./app.js";
import { normalizeError } from "./errors.js";
import {
  cacheModes,
  searchSources,
  searchTimeRanges,
  type CrawlSiteOptions,
  type DurableCrawlOptions,
  type MapSiteOptions,
  type ReadPageOptions,
  type SearchWebOptions,
} from "./types.js";

const browserReadinessInput = z.object({
  target: z.object({
    selector: z.string().trim().min(1).max(512)
      .describe("CSS selector that proves the requested browser content reached its terminal state."),
    state: z.enum(["attached", "visible"]).default("attached"),
    minCount: z.int().min(1).max(10_000).default(1),
  }).strict(),
  interaction: z.object({
    type: z.literal("scroll-to-end"),
    maxSteps: z.int().min(1).max(100),
    stepDelayMs: z.int().min(0).max(5_000).default(100),
  }).strict().optional(),
  timeoutMs: z.int().min(100).max(120_000).optional(),
}).strict();

const readPageInput = z.object({
  url: z.url().describe("Public http or https URL to read."),
  browserAllowed: z.boolean().default(true),
  cacheMode: z.enum(cacheModes).default("prefer-cache"),
  maxAgeSeconds: z.int().positive().max(604_800).default(900),
  authProfile: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional()
    .describe("Dedicated browser profile created with diaoyan-auth."),
  browserReadiness: browserReadinessInput.optional().describe(
    "Explicit browser terminal condition and optional bounded scrolling.",
  ),
});

const siteScopeInput = {
  maxPages: z.int().positive(),
  maxDepth: z.int().min(0).max(10).default(2),
  includeSubdomains: z.boolean().default(false),
  ignoreQueryParameters: z.boolean().default(true),
};

const mapSiteInput = z.object({
  url: z.url().describe("Public site URL to start mapping."),
  browserAllowed: z.boolean().default(true),
  authProfile: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  ...siteScopeInput,
  maxPages: siteScopeInput.maxPages.max(500).default(50),
});

const crawlSiteInput = readPageInput.extend({
  ...siteScopeInput,
  maxPages: siteScopeInput.maxPages.max(50).default(10),
});

const crawlBudgetInput = z.object({
  maxDurationMs: z.int().positive().max(86_400_000),
  maxProviderAttempts: z.int().positive().max(1_000_000),
  maxDocumentBytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  maxBrowserMs: z.int().min(0).max(86_400_000),
  maxBrowserContexts: z.int().min(0).max(100_000),
}).strict();

const durableCrawlInput = readPageInput.extend({
  ...siteScopeInput,
  maxPages: siteScopeInput.maxPages.max(10_000).default(10),
  concurrency: z.int().min(1).max(32).default(4),
  crawlBudget: crawlBudgetInput.optional(),
});

const searchWebInput = z.object({
  query: z.string().trim().min(1).max(512),
  limit: z.int().positive().max(20).default(10),
  page: z.int().positive().max(100).default(1),
  language: z.string().regex(/^(?:all|[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)$/).default("all"),
  safeSearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  timeRange: z.enum(searchTimeRanges).optional(),
  source: z.enum(searchSources).default("auto"),
});

const crawlJobInput = z.object({
  jobId: z.uuid().describe("Crawl job ID returned by start_crawl."),
});

const crawlPagesInput = crawlJobInput.extend({
  afterSequence: z.int().min(0).default(0),
  limit: z.int().min(1).max(1_000).default(100),
});

const crawlerStatsInput = z.object({
  days: z.int().min(1).max(90).default(7),
});

const rslAuditInput = z.object({
  limit: z.int().min(1).max(1_000).default(100),
});

const pageMonitorInput = z.object({
  url: z.url().describe("Public http or https URL to monitor."),
  browserAllowed: z.boolean().default(true),
  authProfile: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  intervalSeconds: z.int().min(60).max(604_800),
});

const monitorIdInput = z.object({
  monitorId: z.uuid().describe("Page monitor ID returned by start_monitor."),
});

const listMonitorsInput = z.object({
  limit: z.int().min(1).max(100).default(20),
});

function successResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function errorResult(error: unknown): CallToolResult {
  const normalized = normalizeError(error);
  return {
    content: [{ type: "text", text: JSON.stringify(normalized.toJSON(), null, 2) }],
    isError: true,
  };
}

function toReadOptions(args: z.infer<typeof readPageInput>): ReadPageOptions {
  const common = {
    url: args.url,
    browserAllowed: args.browserAllowed,
    cacheMode: args.cacheMode,
    maxAgeSeconds: args.maxAgeSeconds,
  };
  return {
    ...common,
    ...(args.authProfile === undefined ? {} : { authProfile: args.authProfile }),
    ...(args.browserReadiness === undefined
      ? {}
      : { browserReadiness: args.browserReadiness }),
  };
}

function toMapOptions(args: z.infer<typeof mapSiteInput>): MapSiteOptions {
  return {
    url: args.url,
    browserAllowed: args.browserAllowed,
    maxPages: args.maxPages,
    maxDepth: args.maxDepth,
    includeSubdomains: args.includeSubdomains,
    ignoreQueryParameters: args.ignoreQueryParameters,
    ...(args.authProfile === undefined ? {} : { authProfile: args.authProfile }),
  };
}

function toCrawlOptions(args: z.infer<typeof crawlSiteInput>): CrawlSiteOptions {
  return {
    ...toReadOptions(args),
    maxPages: args.maxPages,
    maxDepth: args.maxDepth,
    includeSubdomains: args.includeSubdomains,
    ignoreQueryParameters: args.ignoreQueryParameters,
  };
}

function toDurableCrawlOptions(
  args: z.infer<typeof durableCrawlInput>,
): DurableCrawlOptions {
  return {
    ...toReadOptions(args),
    maxPages: args.maxPages,
    maxDepth: args.maxDepth,
    includeSubdomains: args.includeSubdomains,
    ignoreQueryParameters: args.ignoreQueryParameters,
    concurrency: args.concurrency,
    ...(args.crawlBudget === undefined ? {} : { crawlBudget: args.crawlBudget }),
  };
}

function toSearchOptions(args: z.infer<typeof searchWebInput>): SearchWebOptions {
  return {
    query: args.query,
    limit: args.limit,
    page: args.page,
    language: args.language,
    safeSearch: args.safeSearch,
    source: args.source,
    ...(args.timeRange === undefined ? {} : { timeRange: args.timeRange }),
  };
}

export function createMcpServer(app: DiaoyanApp): McpServer {
  const server = new McpServer(
    { name: "diaoyan-web-reader", version: "0.10.4" },
    {
      instructions:
        "Use search_web to discover pages, read_page for one page, map_site for bounded same-site discovery, " +
        "crawl_site for synchronous bounded reading, and start/get/pause/resume/cancel/get-pages controls for durable crawling, " +
        "inspect_page for diagnostics, get_crawler_stats for local operational metrics, " +
        "get_rsl_audit for bounded license and access audit records, " +
        "and start_monitor/get_monitor/list_monitors/cancel_monitor for durable page-change monitoring. " +
        "Access failures are explicit: never treat an isError result as page content. " +
        "Authentication profiles must be created out-of-band by the user.",
    },
  );

  server.registerTool(
    "search_web",
    {
      title: "Search pages",
      description:
        "Search the local page index, a configured web provider, or both, and return normalized URLs and snippets. " +
        "Use source=local for no-network search; web discovery requires DIAOYAN_SEARXNG_URL.",
      inputSchema: searchWebInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args): Promise<CallToolResult> => {
      try {
        return successResult({ ...(await app.search.searchWeb(toSearchOptions(args))) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "read_page",
    {
      title: "Read web page",
      description:
        "Read one authorized web page as Markdown with cache and completeness evidence. " +
        "Does not spoof AI crawlers or bypass access controls.",
      inputSchema: readPageInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await app.reader.readPage(toReadOptions(args));
        return successResult({ ...result });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "inspect_page",
    {
      title: "Inspect web page",
      description:
        "Run the same fetch and completeness checks as read_page but omit the page body.",
      inputSchema: readPageInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await app.reader.inspectPage(toReadOptions(args));
        return successResult({ ...result });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "map_site",
    {
      title: "Map site links",
      description:
        "Discover a bounded set of same-site links without bypassing access controls. " +
        "Runs serially and reports every child-page failure.",
      inputSchema: mapSiteInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args): Promise<CallToolResult> => {
      try {
        return successResult({ ...(await app.site.mapSite(toMapOptions(args))) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "crawl_site",
    {
      title: "Crawl site content",
      description:
        "Read a bounded, same-site set of pages as Markdown with cache and evidence. " +
        "Runs serially and returns partial status with explicit failures when needed.",
      inputSchema: crawlSiteInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args): Promise<CallToolResult> => {
      try {
        return successResult({ ...(await app.site.crawlSite(toCrawlOptions(args))) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "start_crawl",
    {
      title: "Start crawl job",
      description:
        "Persist a page-frontier crawl and return immediately. Supports bounded concurrency, cumulative budgets, and restart recovery.",
      inputSchema: durableCrawlInput,
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    async (args): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.jobs.start(toDurableCrawlOptions(args)) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_crawl",
    {
      title: "Get crawl job",
      description: "Return the durable crawl job status, result, or structured failure.",
      inputSchema: crawlJobInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ jobId }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.jobs.get(jobId) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cancel_crawl",
    {
      title: "Cancel crawl job",
      description:
        "Cancel a queued crawl or request cooperative cancellation of the currently running page crawl.",
      inputSchema: crawlJobInput,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ jobId }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.jobs.cancel(jobId) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "pause_crawl",
    {
      title: "Pause crawl job",
      description: "Stop claiming new pages while allowing already leased pages to settle.",
      inputSchema: crawlJobInput,
      annotations: { idempotentHint: true },
    },
    async ({ jobId }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.jobs.pause(jobId) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "resume_crawl",
    {
      title: "Resume crawl job",
      description: "Resume page claims for a paused durable crawl.",
      inputSchema: crawlJobInput,
      annotations: { idempotentHint: true },
    },
    async ({ jobId }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.jobs.resume(jobId) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_crawl_pages",
    {
      title: "Get crawl page publications",
      description: "Read a stable, cursor-paginated batch of committed page outcomes.",
      inputSchema: crawlPagesInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ jobId, afterSequence, limit }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.jobs.pages(jobId, afterSequence, limit) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "start_monitor",
    {
      title: "Start page monitor",
      description:
        "Persist a single-page monitor, read it immediately to establish a hash baseline, then schedule live reads.",
      inputSchema: pageMonitorInput,
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    async ({ url, browserAllowed, authProfile, intervalSeconds }): Promise<CallToolResult> => {
      try {
        const input = authProfile === undefined
          ? { url, browserAllowed }
          : { url, browserAllowed, authProfile };
        return successResult({ ...(await app.monitors.start(input, intervalSeconds)) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_monitor",
    {
      title: "Get page monitor",
      description: "Return the monitor schedule, counters, content hashes, and last structured run.",
      inputSchema: monitorIdInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ monitorId }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.monitors.get(monitorId) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_monitors",
    {
      title: "List page monitors",
      description: "List recently created scheduled, running, and cancelled page monitors.",
      inputSchema: listMonitorsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }): Promise<CallToolResult> => {
      try {
        return successResult({ monitors: app.monitors.list(limit) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cancel_monitor",
    {
      title: "Cancel page monitor",
      description: "Permanently stop a page monitor and cooperatively cancel its current read.",
      inputSchema: monitorIdInput,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ monitorId }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.monitors.cancel(monitorId) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_crawler_stats",
    {
      title: "Get crawler statistics",
      description:
        "Return privacy-preserving daily success, failure, cache, method, byte, retry, and duration aggregates.",
      inputSchema: crawlerStatsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ days }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.metrics.getStats(days) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_auth_profiles",
    {
      title: "List authentication profiles",
      description: "List dedicated local browser profile names without exposing profile contents.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (): Promise<CallToolResult> => successResult({ profiles: app.profiles.list() }),
  );

  server.registerTool(
    "get_rsl_audit",
    {
      title: "Get RSL access audit",
      description:
        "Return recent content-access outcomes and RSL decisions without page content, profiles, tokens, or credentials.",
      inputSchema: rslAuditInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }): Promise<CallToolResult> => {
      try {
        return successResult({ ...app.rslAudit.list(limit) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
