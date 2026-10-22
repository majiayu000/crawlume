// Soak and capacity runner: drives the built MCP server through repeated durable crawl jobs
// against controlled sites, samples process memory, and fails on incomplete jobs or memory growth.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { createDurableCrawlSite } from "../controlled-site/durable-crawl.js";
import { requireStructuredResult, startCrawl, waitForTerminalCrawl, type JsonRecord } from "../harness/crawl-e2e.js";
import { startBuiltMcpProcess } from "../harness/mcp-process.js";

type Sample = { elapsedMs: number; rssBytes: number; publishedPages: number; jobs: number };



function integerOption(value: string | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function progressCount(job: JsonRecord, field: string): number {
  const progress = job.progress as JsonRecord | null | undefined;
  const value = progress?.[field];
  if (typeof value !== "number") throw new Error(`crawl progress has no ${field}: ${JSON.stringify(job)}`);
  return value;
}

function rssBytes(pid: number): number {
  const kilobytes = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
  if (!Number.isFinite(kilobytes) || kilobytes <= 0) throw new Error(`could not read RSS of process ${pid}`);
  return kilobytes * 1024;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const { values } = parseArgs({
  options: {
    "duration-minutes": { type: "string" },
    "total-pages": { type: "string" },
    "pages-per-job": { type: "string" },
    concurrency: { type: "string" },
    "sample-seconds": { type: "string" },
    "max-rss-growth-percent": { type: "string" },
    "report-dir": { type: "string" },
  },
  strict: true,
});
const durationMs = integerOption(values["duration-minutes"], "duration-minutes", 10, 1, 20_160) * 60_000;
const totalPages = integerOption(values["total-pages"], "total-pages", 0, 0, 10_000_000);
const pagesPerJob = integerOption(values["pages-per-job"], "pages-per-job", 1_000, 1, 10_000);
const concurrency = integerOption(values.concurrency, "concurrency", 16, 1, 32);
const sampleMs = integerOption(values["sample-seconds"], "sample-seconds", 30, 1, 3_600) * 1_000;
const maxRssGrowth = integerOption(values["max-rss-growth-percent"], "max-rss-growth-percent", 50, 1, 1_000) / 100;
const reportDir = resolve(values["report-dir"] ?? join("benchmarks", "reports", `soak-${new Date().toISOString().replaceAll(":", "-")}`));
mkdirSync(reportDir, { recursive: true });
const samplesPath = join(reportDir, "samples.jsonl");
writeFileSync(samplesPath, "");

// One controlled site serves every job: the server's proxy pool is fixed at startup.
const site = await createDurableCrawlSite({ pages: pagesPerJob });
const dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-soak-"));
const server = await startBuiltMcpProcess({
  dataDirectory,
  controlledDns: true,
  environment: {
    CRAWLUME_CRAWL_MAX_ATTEMPTS: "2",
    CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS: "0",
    CRAWLUME_CRAWL_RETRY_BASE_MS: "0",
    CRAWLUME_CRAWL_WORKER_CONCURRENCY: String(concurrency),
    CRAWLUME_LOCAL_INDEX_ENABLED: totalPages > 0 ? "1" : "0",
    CRAWLUME_PROXY_URLS: site.proxyUrl,
    CRAWLUME_REQUEST_TIMEOUT_MS: "30000",
  },
});

const startedAt = Date.now();
const rssSamples: number[] = [];
let peakRss = 0;
let jobCount = 0;
let completedAt = startedAt;
let lastSeedUrl = site.seedUrl;
let capacity: Record<string, number | boolean> | null = null;
const deadline = startedAt + durationMs;
function remainingMs(): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("soak duration limit exceeded");
  return remaining;
}
async function withinDeadline<T>(operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("soak duration limit exceeded")), remainingMs());
      }),
    ]);
    remainingMs();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
let publishedPages = 0;
let failure: string | null = null;
const record = (): void => {
  const sample = { elapsedMs: Date.now() - startedAt, rssBytes: rssBytes(server.pid), publishedPages, jobs: jobCount };
  rssSamples.push(sample.rssBytes);
  peakRss = Math.max(peakRss, sample.rssBytes);
  appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`);
};
const sampler = setInterval(() => {
  try {
    record();
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  }
}, sampleMs);

try {
  record();
  while (failure === null && Date.now() - startedAt < durationMs && (totalPages === 0 || publishedPages < totalPages)) {
    const pages = totalPages === 0 ? pagesPerJob : Math.min(pagesPerJob, totalPages - publishedPages);
    {
      lastSeedUrl = site.startBatch(pages);
      const started = await withinDeadline(() => startCrawl(server, {
        url: lastSeedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: pages,
        maxDepth: 1,
        concurrency,
        crawlBudget: {
          maxDurationMs: Math.min(remainingMs(), Math.max(600_000, pages * 200)),
          maxProviderAttempts: pages * 2,
          maxDocumentBytes: pages * 64_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      }));
      const terminal = await withinDeadline(() => waitForTerminalCrawl(server, started.id, remainingMs()));
      const job = {
        id: started.id,
        status: String(terminal.status),
        succeeded: progressCount(terminal, "succeededCount"),
        failed: progressCount(terminal, "failedCount"),
        stopped: progressCount(terminal, "stoppedCount"),
      };
      jobCount += 1;
      publishedPages += job.succeeded + job.failed + job.stopped;
      if (job.status !== "completed" || job.succeeded !== pages) {
        failure = `job ${job.id} ended ${job.status} with ${job.succeeded}/${pages} succeeded pages`;
      }
    }
  }
  if (totalPages > 0 && publishedPages === totalPages && failure === null) {
    const database = new DatabaseSync(join(dataDirectory, "cache.sqlite"), { readOnly: true });
    try {
      const count = (sql: string): number => (database.prepare(sql).get() as { count: number }).count;
      const indexedPages = count("SELECT count(*) AS count FROM indexed_pages");
      const historyUrls = count("SELECT count(DISTINCT final_url) AS count FROM indexed_page_history");
      const ftsMatches = count("SELECT count(*) AS count FROM page_index WHERE page_index MATCH 'durable'");
      if (indexedPages !== totalPages || historyUrls !== totalPages || ftsMatches !== totalPages) {
        throw new Error(`capacity projection mismatch: ${JSON.stringify({ indexedPages, historyUrls, ftsMatches })}`);
      }
      capacity = { indexedPages, historyUrls, ftsMatches, fullCapacityRejected: false, existingUrlUpdated: false };
      if (totalPages === 300_000) {
        requireStructuredResult(await withinDeadline(() => server.callTool("read_page", {
          url: lastSeedUrl, browserAllowed: false, cacheMode: "live",
        })), "read_page at capacity");
        capacity.existingUrlUpdated = count("SELECT count(*) AS count FROM indexed_page_history") > totalPages;
        const overflow = await withinDeadline(() => server.callTool("read_page", {
          url: site.startBatch(1), browserAllowed: false, cacheMode: "live",
        }));
        const errorText = overflow.content.filter((item) => item.type === "text").map((item) => item.text).join("");
        capacity.fullCapacityRejected = overflow.isError === true && JSON.parse(errorText).code === "BUDGET_EXHAUSTED";
        if (!capacity.fullCapacityRejected || !capacity.existingUrlUpdated) throw new Error("full-capacity behavior failed");
      }
      remainingMs();
    } finally { database.close(); }
  }
  record();
} catch (error) {
  failure ??= error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  completedAt = Date.now();
  clearInterval(sampler);
  await server.close().catch(() => undefined);
  await site.close();
  await rm(dataDirectory, { recursive: true, force: true });
}

const quarter = Math.max(1, Math.floor(rssSamples.length / 4));
const earlyRss = median(rssSamples.slice(0, quarter));
const lateRss = median(rssSamples.slice(-quarter));
const rssGrowth = earlyRss === 0 ? 0 : (lateRss - earlyRss) / earlyRss;
if (failure === null && rssSamples.length >= 8 && rssGrowth > maxRssGrowth) {
  failure = `RSS grew ${(rssGrowth * 100).toFixed(1)}% (limit ${(maxRssGrowth * 100).toFixed(0)}%)`;
}
if (failure === null && totalPages > 0 && publishedPages < totalPages) {
  failure = `published ${publishedPages} of ${totalPages} pages before the duration limit`;
}
const elapsedMs = completedAt - startedAt;
const summary = {
  passed: failure === null,
  failure,
  elapsedMs,
  jobs: jobCount,
  publishedPages,
  pagesPerSecond: elapsedMs === 0 ? 0 : publishedPages / (elapsedMs / 1_000),
  rss: { earlyMedianBytes: earlyRss, lateMedianBytes: lateRss, growth: rssGrowth, peakBytes: peakRss },
  capacity,
  config: { durationMs, totalPages, pagesPerJob, concurrency, sampleMs, maxRssGrowth },
};
writeFileSync(join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...summary, reportDir }, null, 2)}\n`);
process.exitCode = summary.passed ? 0 : 1;
