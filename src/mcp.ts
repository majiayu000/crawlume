import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DiaoyanApp } from "./app.js";
import { normalizeError } from "./errors.js";
import {
  cacheModes,
  fetchModes,
  searchTimeRanges,
  type CrawlSiteOptions,
  type MapSiteOptions,
  type ReadPageOptions,
  type SearchWebOptions,
} from "./types.js";

const readPageInput = z.object({
  url: z.url().describe("Public http or https URL to read."),
  mode: z.enum(fetchModes).default("auto"),
  cacheMode: z.enum(cacheModes).default("prefer-cache"),
  maxAgeSeconds: z.int().positive().max(604_800).default(900),
  authProfile: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional()
    .describe("Dedicated browser profile created with diaoyan-auth."),
});

const siteScopeInput = {
  maxPages: z.int().positive(),
  maxDepth: z.int().min(0).max(10).default(2),
  includeSubdomains: z.boolean().default(false),
  ignoreQueryParameters: z.boolean().default(true),
};

const mapSiteInput = z.object({
  url: z.url().describe("Public site URL to start mapping."),
  mode: z.enum(fetchModes).default("auto"),
  authProfile: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  ...siteScopeInput,
  maxPages: siteScopeInput.maxPages.max(500).default(50),
});

const crawlSiteInput = readPageInput.extend({
  ...siteScopeInput,
  maxPages: siteScopeInput.maxPages.max(50).default(10),
});

const searchWebInput = z.object({
  query: z.string().trim().min(1).max(512),
  limit: z.int().positive().max(20).default(10),
  page: z.int().positive().max(100).default(1),
  language: z.string().regex(/^(?:all|[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)$/).default("all"),
  safeSearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  timeRange: z.enum(searchTimeRanges).optional(),
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
    mode: args.mode,
    cacheMode: args.cacheMode,
    maxAgeSeconds: args.maxAgeSeconds,
  };
  return args.authProfile === undefined ? common : { ...common, authProfile: args.authProfile };
}

function toMapOptions(args: z.infer<typeof mapSiteInput>): MapSiteOptions {
  return {
    url: args.url,
    mode: args.mode,
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

function toSearchOptions(args: z.infer<typeof searchWebInput>): SearchWebOptions {
  return {
    query: args.query,
    limit: args.limit,
    page: args.page,
    language: args.language,
    safeSearch: args.safeSearch,
    ...(args.timeRange === undefined ? {} : { timeRange: args.timeRange }),
  };
}

export function createMcpServer(app: DiaoyanApp): McpServer {
  const server = new McpServer(
    { name: "diaoyan-web-reader", version: "0.3.0" },
    {
      instructions:
        "Use search_web to discover pages, read_page for one page, map_site for bounded same-site discovery, " +
        "crawl_site for bounded multi-page reading, and inspect_page for diagnostics. " +
        "Access failures are explicit: never treat an isError result as page content. " +
        "Authentication profiles must be created out-of-band by the user.",
    },
  );

  server.registerTool(
    "search_web",
    {
      title: "Search the web",
      description:
        "Search through the configured provider and return normalized result URLs and snippets. " +
        "Requires DIAOYAN_SEARXNG_URL for the current SearXNG provider.",
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
    "list_auth_profiles",
    {
      title: "List authentication profiles",
      description: "List dedicated local browser profile names without exposing profile contents.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (): Promise<CallToolResult> => successResult({ profiles: app.profiles.list() }),
  );

  return server;
}
