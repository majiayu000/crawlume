import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiaoyanApp } from "../src/app.js";
import { ReadError } from "../src/errors.js";
import { createMcpServer } from "../src/mcp.js";
import type { ReadPageResult } from "../src/types.js";

const openClients: Client[] = [];
const openServers: ReturnType<typeof createMcpServer>[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map(async (client) => client.close()));
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

function result(): ReadPageResult {
  return {
    status: "ok",
    sourceUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    fetchedAt: "2026-08-24T00:00:00.000Z",
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "Example article",
    byline: null,
    publishedTime: null,
    contentMarkdown: "Complete article content.",
    contentHash: "abc123",
    completeness: "complete",
    validation: { status: "usable", warnings: [] },
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 123,
      contentCharacters: 400,
      extractionMethod: "readability",
    },
  };
}

function siteResult() {
  return {
    status: "ok" as const,
    sourceUrl: "https://example.com/",
    startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:00:01.000Z",
    scannedPages: 1,
    failures: [],
    truncated: false,
  };
}

function jobResult(status: "queued" | "running" | "completed" | "cancelled" = "queued") {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    status,
    input: { url: "https://example.com/", maxPages: 2 },
    createdAt: "2026-08-25T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
  };
}

async function connect(app: DiaoyanApp): Promise<Client> {
  const server = createMcpServer(app);
  const client = new Client({ name: "diaoyan-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  openClients.push(client);
  openServers.push(server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server", () => {
  it("advertises and invokes all reader tools through an MCP client", async () => {
    const readPage = vi.fn(async () => result());
    const inspectPage = vi.fn(async () => {
      const { contentMarkdown: _contentMarkdown, ...inspection } = result();
      return inspection;
    });
    const app = {
      reader: { readPage, inspectPage },
      site: {
        mapSite: vi.fn(async () => ({
          ...siteResult(),
          urls: [{ url: "https://example.com/", depth: 0, discoveredFrom: null }],
        })),
        crawlSite: vi.fn(async () => ({
          ...siteResult(),
          pages: [{ url: "https://example.com/", depth: 0, discoveredFrom: null, result: result() }],
        })),
      },
      search: {
        searchWeb: vi.fn(async () => ({
          status: "ok" as const,
          query: "MiniMax H3",
          provider: "searxng",
          searchedAt: "2026-08-25T00:00:00.000Z",
          page: 1,
          results: [
            {
              title: "MiniMax H3",
              url: "https://example.com/h3",
              snippet: "Inference guide",
              source: "web" as const,
              engines: ["bing"],
              score: 1,
              publishedAt: null,
              thumbnailUrl: null,
            },
          ],
          totalResults: 1,
          warnings: [],
        })),
      },
      jobs: {
        start: vi.fn(() => jobResult()),
        get: vi.fn(() => jobResult("running")),
        cancel: vi.fn(() => jobResult("cancelled")),
      },
      profiles: { list: () => ["work"] },
      close: async () => undefined,
    } as unknown as DiaoyanApp;
    const client = await connect(app);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "inspect_page",
      "list_auth_profiles",
      "map_site",
      "crawl_site",
      "start_crawl",
      "get_crawl",
      "cancel_crawl",
      "read_page",
      "search_web",
    ].sort());

    const read = await client.callTool({
      name: "read_page",
      arguments: { url: "https://example.com/article", mode: "http" },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ status: "ok", completeness: "complete" });
    expect(readPage).toHaveBeenCalledOnce();

    const profiles = await client.callTool({ name: "list_auth_profiles", arguments: {} });
    expect(profiles.structuredContent).toEqual({ profiles: ["work"] });

    const mapped = await client.callTool({
      name: "map_site",
      arguments: { url: "https://example.com/", maxPages: 3 },
    });
    expect(mapped.structuredContent).toMatchObject({ status: "ok", scannedPages: 1 });

    const crawled = await client.callTool({
      name: "crawl_site",
      arguments: { url: "https://example.com/", maxPages: 2 },
    });
    expect(crawled.structuredContent).toMatchObject({ status: "ok", scannedPages: 1 });

    const searched = await client.callTool({
      name: "search_web",
      arguments: { query: "MiniMax H3", limit: 5 },
    });
    expect(searched.structuredContent).toMatchObject({
      status: "ok",
      provider: "searxng",
      totalResults: 1,
    });

    const started = await client.callTool({
      name: "start_crawl",
      arguments: { url: "https://example.com/", maxPages: 2 },
    });
    expect(started.structuredContent).toMatchObject({ status: "queued", input: { maxPages: 2 } });

    const job = await client.callTool({
      name: "get_crawl",
      arguments: { jobId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(job.structuredContent).toMatchObject({ status: "running" });

    const cancelled = await client.callTool({
      name: "cancel_crawl",
      arguments: { jobId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(cancelled.structuredContent).toMatchObject({ status: "cancelled" });
  });

  it("returns structured tool errors with isError", async () => {
    const app = {
      reader: {
        readPage: async () => {
          throw new ReadError("ACCESS_DENIED", "The site denied access.");
        },
        inspectPage: async () => {
          throw new ReadError("ACCESS_DENIED", "The site denied access.");
        },
      },
      site: {
        mapSite: async () => {
          throw new ReadError("ACCESS_DENIED", "The site denied access.");
        },
        crawlSite: async () => {
          throw new ReadError("ACCESS_DENIED", "The site denied access.");
        },
      },
      search: {
        searchWeb: async () => {
          throw new ReadError("SEARCH_PROVIDER_NOT_CONFIGURED", "Search is not configured.");
        },
      },
      jobs: {
        start: () => {
          throw new ReadError("ACCESS_DENIED", "The site denied access.");
        },
        get: () => {
          throw new ReadError("JOB_NOT_FOUND", "The crawl job does not exist.");
        },
        cancel: () => {
          throw new ReadError("JOB_NOT_FOUND", "The crawl job does not exist.");
        },
      },
      profiles: { list: () => [] },
      close: async () => undefined,
    } as unknown as DiaoyanApp;
    const client = await connect(app);
    const response = await client.callTool({
      name: "read_page",
      arguments: { url: "https://example.com/denied" },
    });
    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("ACCESS_DENIED") }),
    ]);
  });
});
