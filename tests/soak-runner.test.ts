import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => ({
  updates: 0, toolCalls: 0, now: 0, total: 5, pagesPerJob: 2, completed: 0, delay: 0, samples: 0,
  batches: [] as number[], paths: [] as string[], summary: {} as Record<string, any>,
  sampler: undefined as (() => void) | undefined,
}));
vi.mock("node:child_process", () => ({ execFileSync: () => "1024" }));
vi.mock("node:fs", () => ({
  mkdirSync: () => {}, appendFileSync: () => {},
  writeFileSync: (path: string, content: string) => {
    if (path.endsWith("summary.json")) run.summary = JSON.parse(content);
    if (path.endsWith("samples.jsonl")) expect(content).toBe("");
  },
}));
vi.mock("node:fs/promises", () => ({
  mkdtemp: async () => "/fake/soak", rm: async () => { run.now += 100_000; },
}));
vi.mock("node:util", () => ({ parseArgs: () => ({ values: {
  "total-pages": String(run.total), "pages-per-job": String(run.pagesPerJob),
  "duration-minutes": "1", "sample-seconds": "1", "report-dir": "/fake/report",
} }) }));
vi.mock("node:sqlite", () => ({ DatabaseSync: class {
  prepare(sql: string) { return { get: () => ({ count: run.completed + (sql === "SELECT count(*) AS count FROM indexed_page_history" ? run.updates : 0) }) }; }
  close() {}
} }));
vi.mock("../benchmarks/controlled-site/durable-crawl.js", () => ({
  createDurableCrawlSite: async () => ({
    seedUrl: "http://example.com/seed", proxyUrl: "http://127.0.0.1:1234",
    startBatch: (pages: number) => { run.batches.push(pages); return `http://example.com/${run.batches.length}`; },
    close: async () => {},
  }),
}));
vi.mock("../benchmarks/harness/mcp-process.js", () => ({
  startBuiltMcpProcess: async () => ({ pid: 1, close: async () => {},
    callTool: async () => {
      run.toolCalls += 1;
      if (run.toolCalls === 1) { run.updates += 1; return { content: [], structuredContent: {} }; }
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "BUDGET_EXHAUSTED" }) }] };
    },
  }),
}));
vi.mock("../benchmarks/harness/crawl-e2e.js", () => ({
  requireStructuredResult: vi.fn(),
  startCrawl: async (_server: unknown, args: { url: string }) => {
    run.paths.push(args.url);
    return { id: "job" };
  },
  waitForTerminalCrawl: async () => {
    for (let sample = 0; sample < run.samples; sample += 1) run.sampler?.();
    run.now += run.delay;
    const pages = run.batches.at(-1)!;
    run.completed += pages;
    return { status: "completed", progress: { succeededCount: pages, failedCount: 0, stoppedCount: 0 } };
  },
}));
beforeEach(() => {
  vi.resetModules();
  Object.assign(run, { updates: 0, toolCalls: 0, now: 0, total: 5, pagesPerJob: 2, completed: 0, delay: 0, samples: 0,
    batches: [], paths: [], summary: {}, sampler: undefined });
  vi.spyOn(Date, "now").mockImplementation(() => run.now);
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    run.sampler = callback;
    return { unref() {} } as unknown as NodeJS.Timeout;
  }) as typeof setInterval);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe("soak runner result boundaries", () => {
  it("uses unique batches and an exact one-page tail; excludes teardown time", async () => {
    await import("../benchmarks/soak/runner.js");
    expect(run.batches).toEqual([2, 2, 1]);
    expect(new Set(run.paths).size).toBe(3);
    expect(run.summary).toMatchObject({ passed: true, publishedPages: 5, elapsedMs: 0,
      capacity: { indexedPages: 5, historyUrls: 5, ftsMatches: 5 } });
  });
  it("requires update and overflow checks at the 300k capacity boundary", async () => {
    run.total = 300_000;
    run.pagesPerJob = 10_000;
    await import("../benchmarks/soak/runner.js");
    expect(run.batches).toHaveLength(31);
    expect(run.summary).toMatchObject({ passed: true, publishedPages: 300_000,
      capacity: { indexedPages: 300_000, fullCapacityRejected: true, existingUrlUpdated: true } });
  });
  it("rejects terminal results received beyond the duration deadline", async () => {
    run.delay = 60_001;
    await import("../benchmarks/soak/runner.js");
    expect(run.summary).toMatchObject({ passed: false, publishedPages: 0 });
    expect(run.summary.failure).toContain("duration limit exceeded");
  });
  it("writes a summary for more samples than V8 permits as call arguments", async () => {
    run.total = 1;
    run.samples = 604_800;
    await import("../benchmarks/soak/runner.js");
    expect(run.summary).toMatchObject({ passed: true, rss: { peakBytes: 1_048_576 } });
  });
});
