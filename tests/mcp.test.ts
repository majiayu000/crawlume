import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiaoyanApp } from "../src/app.js";
import type { WorkerHttpApi, WorkerHttpResponse } from "../src/control-plane/organization-service.js";
import { ReadError } from "../src/errors.js";
import { createMcpServer } from "../src/mcp.js";
import {
  startWorkerControlServer,
  type WorkerControlListener,
} from "../src/server.js";
import type { ReadPageResult } from "../src/types.js";

const openClients: Client[] = [];
const openServers: ReturnType<typeof createMcpServer>[] = [];
const openWorkerListeners: WorkerControlListener[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map(async (client) => client.close()));
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
  await Promise.all(openWorkerListeners.splice(0).map(async (listener) => listener.close()));
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
    validation: { outcome: "valid", validatorVersion: "generic-content-v1", checks: [], terminalError: null },
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 123,
      contentCharacters: 400,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId: "request-test",
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{
          stageId: "http-read",
          provider: "http",
          reasonCode: "HTTP_PRIMARY",
        }],
        executedStages: ["http-read"],
      },
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

function jobResult(
  status: "queued" | "running" | "paused" | "completed" | "cancelled" = "queued",
) {
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

function monitorResult(status: "scheduled" | "running" | "cancelled" = "scheduled") {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status,
    input: { url: "https://example.com/article", browserAllowed: true },
    intervalSeconds: 300,
    createdAt: "2026-08-25T00:00:00.000Z",
    startedAt: null,
    nextRunAt: "2026-08-25T00:05:00.000Z",
    lastContentHash: null,
    lastChangedAt: null,
    runCount: 0,
    changeCount: 0,
    failureCount: 0,
    lastRun: null,
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
    const waitForPages = vi.fn(async () => ({
      jobId: "00000000-0000-4000-8000-000000000001",
      pages: [],
      nextSequence: 0,
      done: false,
    }));
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
        status: vi.fn(() => ({
          status: "ready" as const,
          localIndexAvailable: true,
          localDocuments: 1,
          webProvider: "searxng",
          retrievalVersion: "local-fts5-v1",
        })),
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
          trace: {
            correlationId: "00000000-0000-4000-8000-000000000002",
            requestedSource: "auto" as const,
            executedSources: ["web"] as const,
            localSnapshot: null,
          },
        })),
      },
      jobs: {
        start: vi.fn(() => jobResult()),
        get: vi.fn(() => jobResult("running")),
        pause: vi.fn(() => jobResult("paused")),
        resume: vi.fn(() => jobResult("running")),
        cancel: vi.fn(() => jobResult("cancelled")),
        pages: vi.fn(() => ({
          jobId: "00000000-0000-4000-8000-000000000001",
          pages: [],
          nextSequence: 0,
          done: false,
        })),
        waitForPages,
      },
      profiles: { list: () => ["work"] },
      metrics: {
        getStats: vi.fn(() => ({
          status: "ok" as const,
          generatedAt: "2026-08-25T00:00:00.000Z",
          since: "2026-08-19T00:00:00.000Z",
          days: 7,
          totals: {
            requests: 4,
            successes: 3,
            failures: 1,
            successRate: 0.75,
            cacheHits: 1,
            cacheHitRate: 1 / 3,
          },
          fetchMethods: { http: 2, browser: 1 },
          cost: {
            responseBytes: 1_000,
            contentCharacters: 800,
            attempts: 4,
            retryDelayMs: 0,
            durationMs: 500,
          },
          failureReasons: [{ code: "ACCESS_DENIED", count: 1 }],
          daily: [],
        })),
      },
      searchMetrics: {
        getStats: vi.fn(() => ({
          status: "ok" as const,
          generatedAt: "2026-08-25T00:00:00.000Z",
          since: "2026-08-19T00:00:00.000Z",
          days: 7,
          totals: {
            requests: 4,
            ok: 2,
            partial: 1,
            failed: 1,
            completeRate: 0.5,
            usableRate: 0.75,
          },
          latencyMs: { p50: 20, p95: 100, max: 100 },
          requestedSources: { auto: 3, local: 0, web: 1 },
          executedSources: { local: 1, web: 1, hybrid: 1, unobserved: 1 },
          resultCount: 3,
          warningCount: 1,
          failureReasons: [{ code: "SEARCH_PROVIDER_ERROR", count: 1 }],
        })),
      },
      rslAudit: {
        list: vi.fn(() => ({
          status: "ok" as const,
          generatedAt: "2026-08-25T00:00:00.000Z",
          entries: [],
        })),
      },
      monitors: {
        start: vi.fn(async () => monitorResult()),
        get: vi.fn(() => monitorResult("running")),
        list: vi.fn(() => [monitorResult()]),
        cancel: vi.fn(() => ({ ...monitorResult("cancelled"), nextRunAt: null })),
      },
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
      "get_crawler_stats",
      "get_rsl_audit",
      "get_search_stats",
      "get_search_status",
      "start_monitor",
      "get_monitor",
      "list_monitors",
      "cancel_monitor",
      "cancel_crawl",
      "pause_crawl",
      "resume_crawl",
      "get_crawl_pages",
      "read_page",
      "search_web",
    ].sort());

    const searchStatus = await client.callTool({
      name: "get_search_status",
      arguments: {},
    });
    expect(searchStatus.isError).not.toBe(true);
    expect(searchStatus.structuredContent).toEqual({
      status: "ready",
      localIndexAvailable: true,
      localDocuments: 1,
      webProvider: "searxng",
      retrievalVersion: "local-fts5-v1",
    });

    const searchStats = await client.callTool({
      name: "get_search_stats",
      arguments: { days: 7 },
    });
    expect(searchStats.isError).not.toBe(true);
    expect(searchStats.structuredContent).toMatchObject({
      status: "ok",
      totals: { requests: 4, ok: 2, partial: 1, failed: 1 },
      latencyMs: { p50: 20, p95: 100, max: 100 },
    });

    const read = await client.callTool({
      name: "read_page",
      arguments: { url: "https://example.com/article", browserAllowed: false },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ status: "ok", completeness: "complete" });
    expect(readPage).toHaveBeenCalledOnce();
    expect(readPage).toHaveBeenLastCalledWith({
      url: "https://example.com/article",
      browserAllowed: false,
    });

    const targetedRead = await client.callTool({
      name: "read_page",
      arguments: {
        url: "https://example.com/feed",
        browserAllowed: true,
        staleWhileRevalidateSeconds: 120,
        browserReadiness: {
          target: { selector: "[data-terminal='true']", state: "visible", minCount: 1 },
          interaction: { type: "scroll-to-end", maxSteps: 8, stepDelayMs: 50 },
          timeoutMs: 5_000,
        },
      },
    });
    expect(targetedRead.isError).not.toBe(true);
    expect(readPage).toHaveBeenLastCalledWith(expect.objectContaining({
      browserReadiness: {
        target: { selector: "[data-terminal='true']", state: "visible", minCount: 1 },
        interaction: { type: "scroll-to-end", maxSteps: 8, stepDelayMs: 50 },
        timeoutMs: 5_000,
      },
      staleWhileRevalidateSeconds: 120,
    }));

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
      trace: {
        correlationId: "00000000-0000-4000-8000-000000000002",
        requestedSource: "auto",
        executedSources: ["web"],
        localSnapshot: null,
      },
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

    const paused = await client.callTool({
      name: "pause_crawl",
      arguments: { jobId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(paused.structuredContent).toMatchObject({ status: "paused" });

    const resumed = await client.callTool({
      name: "resume_crawl",
      arguments: { jobId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(resumed.structuredContent).toMatchObject({ status: "running" });

    const pages = await client.callTool({
      name: "get_crawl_pages",
      arguments: { jobId: "00000000-0000-4000-8000-000000000001", limit: 10 },
    });
    expect(pages.structuredContent).toMatchObject({ nextSequence: 0, done: false });

    const waitedPages = await client.callTool({
      name: "get_crawl_pages",
      arguments: {
        jobId: "00000000-0000-4000-8000-000000000001",
        afterSequence: 0,
        limit: 10,
        waitMs: 1_000,
      },
    });
    expect(waitedPages.structuredContent).toMatchObject({ nextSequence: 0, done: false });
    expect(waitForPages).toHaveBeenCalledOnce();
    expect(waitForPages).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      0,
      10,
      1_000,
      expect.any(AbortSignal),
    );

    const cancelled = await client.callTool({
      name: "cancel_crawl",
      arguments: { jobId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(cancelled.structuredContent).toMatchObject({ status: "cancelled" });

    const stats = await client.callTool({
      name: "get_crawler_stats",
      arguments: { days: 7 },
    });
    expect(stats.structuredContent).toMatchObject({
      status: "ok",
      totals: { requests: 4, successes: 3, failures: 1 },
    });

    const audit = await client.callTool({
      name: "get_rsl_audit",
      arguments: { limit: 50 },
    });
    expect(audit.structuredContent).toMatchObject({ status: "ok", entries: [] });

    const startedMonitor = await client.callTool({
      name: "start_monitor",
      arguments: { url: "https://example.com/article", intervalSeconds: 300 },
    });
    expect(startedMonitor.structuredContent).toMatchObject({
      status: "scheduled",
      intervalSeconds: 300,
    });

    const monitor = await client.callTool({
      name: "get_monitor",
      arguments: { monitorId: "00000000-0000-4000-8000-000000000002" },
    });
    expect(monitor.structuredContent).toMatchObject({ status: "running" });

    const monitors = await client.callTool({
      name: "list_monitors",
      arguments: { limit: 10 },
    });
    expect(monitors.structuredContent).toMatchObject({
      monitors: [expect.objectContaining({ intervalSeconds: 300 })],
    });

    const cancelledMonitor = await client.callTool({
      name: "cancel_monitor",
      arguments: { monitorId: "00000000-0000-4000-8000-000000000002" },
    });
    expect(cancelledMonitor.structuredContent).toMatchObject({
      status: "cancelled",
      nextRunAt: null,
    });
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
        status: () => {
          throw new ReadError("INTERNAL_ERROR", "Search status is unavailable.");
        },
        searchWeb: async () => {
          throw new ReadError("SEARCH_PROVIDER_NOT_CONFIGURED", "Search is not configured.");
        },
      },
      searchMetrics: {
        getStats: () => {
          throw new ReadError("INTERNAL_ERROR", "Search statistics are unavailable.");
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
      monitors: {
        start: async () => {
          throw new ReadError("ACCESS_DENIED", "The site denied access.");
        },
        get: () => {
          throw new ReadError("MONITOR_NOT_FOUND", "The page monitor does not exist.");
        },
        list: () => [],
        cancel: () => {
          throw new ReadError("MONITOR_NOT_FOUND", "The page monitor does not exist.");
        },
      },
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

    const missingMonitor = await client.callTool({
      name: "get_monitor",
      arguments: { monitorId: "00000000-0000-4000-8000-000000000099" },
    });
    expect(missingMonitor.isError).toBe(true);
    expect(missingMonitor.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("MONITOR_NOT_FOUND") }),
    ]);

    const searchStatus = await client.callTool({ name: "get_search_status", arguments: {} });
    expect(searchStatus.isError).toBe(true);
    expect(searchStatus.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("INTERNAL_ERROR") }),
    ]);

    const searchStats = await client.callTool({
      name: "get_search_stats",
      arguments: { days: 7 },
    });
    expect(searchStats.isError).toBe(true);
    expect(searchStats.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("INTERNAL_ERROR") }),
    ]);
  });
});

function workerOk(body: unknown = { ok: true }): WorkerHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "request-a" },
    body,
  };
}

async function openWorkerServer(api: Pick<WorkerHttpApi, "handle">): Promise<WorkerControlListener> {
  const listener = await startWorkerControlServer(api, {
    host: "127.0.0.1",
    port: 0,
    tls: null,
  });
  openWorkerListeners.push(listener);
  return listener;
}

describe("Worker control HTTP transport", () => {
  it("refuses a non-loopback plaintext listener before binding", async () => {
    const api = { handle: vi.fn(async () => workerOk()) };
    await expect(startWorkerControlServer(api, {
      host: "0.0.0.0",
      port: 0,
      tls: null,
    })).rejects.toThrow("requires TLS outside an exact loopback address");
    expect(api.handle).not.toHaveBeenCalled();
  });

  it("passes bounded JSON into the Worker API over a real loopback socket", async () => {
    const handle = vi.fn(async (request: Parameters<WorkerHttpApi["handle"]>[0]) =>
      workerOk({ path: request.path, body: request.body }));
    const listener = await openWorkerServer({ handle });
    const response = await fetch(`${listener.origin}/v1/workers/00000000-0000-4000-8000-000000000031/claims`, {
      method: "POST",
      headers: { authorization: "Bearer aaa.bbb.ccc", "content-type": "application/json" },
      body: JSON.stringify({ wait_ms: 0 }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      path: "/v1/workers/00000000-0000-4000-8000-000000000031/claims",
      body: { wait_ms: 0 },
    });
    expect(handle.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it("rejects malformed, compressed, query-bearing, and oversized requests before dispatch", async () => {
    const handle = vi.fn(async () => workerOk());
    const listener = await openWorkerServer({ handle });
    const post = (suffix: string, body: string, headers: Record<string, string> = {}) => fetch(
      `${listener.origin}/v1/job-leases/00000000-0000-4000-8000-000000000071/events${suffix}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      },
    );

    const malformed = await post("", "{");
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ code: "JSON_INVALID" });
    const compressed = await post("", "{}", { "content-encoding": "gzip" });
    expect(compressed.status).toBe(415);
    await expect(compressed.json()).resolves.toMatchObject({ code: "CONTENT_ENCODING_UNSUPPORTED" });
    const query = await post("?project_id=forged", "{}");
    expect(query.status).toBe(400);
    await expect(query.json()).resolves.toMatchObject({ code: "QUERY_UNSUPPORTED" });
    const oversized = await post("", "x".repeat(65_537));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ code: "REQUEST_BODY_TOO_LARGE" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("propagates client disconnect to the long-poll AbortSignal", async () => {
    let receivedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let markAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolveAborted) => {
      markAborted = resolveAborted;
    });
    const handle = vi.fn(async (request: Parameters<WorkerHttpApi["handle"]>[0]) => {
      receivedSignal = request.signal;
      markStarted?.();
      await new Promise<void>((resolveAbort) => request.signal?.addEventListener("abort", () => {
        markAborted?.();
        resolveAbort();
      }, { once: true }));
      return workerOk();
    });
    const listener = await openWorkerServer({ handle });
    const controller = new AbortController();
    const response = fetch(`${listener.origin}/v1/workers/00000000-0000-4000-8000-000000000031/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    await aborted;
    expect(receivedSignal?.aborted).toBe(true);
  });
});
