// Soak and capacity runner: drives the built MCP server through repeated durable crawl jobs
// against controlled sites, samples process memory, and fails on incomplete jobs or memory growth.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createDurableCrawlSite } from "../controlled-site/durable-crawl.js";
import { startCrawl, waitForTerminalCrawl, type JsonRecord } from "../harness/crawl-e2e.js";
import { startBuiltMcpProcess } from "../harness/mcp-process.js";

type Sample = { elapsedMs: number; rssBytes: number; publishedPages: number; jobs: number };

type JobResult = { id: string; status: string; succeeded: number; failed: number; stopped: number };

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
const pagesPerJob = integerOption(values["pages-per-job"], "pages-per-job", 1_000, 2, 10_000);
const concurrency = integerOption(values.concurrency, "concurrency", 16, 1, 32);
const sampleMs = integerOption(values["sample-seconds"], "sample-seconds", 30, 1, 3_600) * 1_000;
const maxRssGrowth = integerOption(values["max-rss-growth-percent"], "max-rss-growth-percent", 50, 1, 1_000) / 100;
const reportDir = resolve(values["report-dir"] ?? join("benchmarks", "reports", `soak-${new Date().toISOString().replaceAll(":", "-")}`));
mkdirSync(reportDir, { recursive: true });
const samplesPath = join(reportDir, "samples.jsonl");

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
    CRAWLUME_LOCAL_INDEX_ENABLED: "0",
    CRAWLUME_PROXY_URLS: site.proxyUrl,
    CRAWLUME_REQUEST_TIMEOUT_MS: "30000",
  },
});

const startedAt = Date.now();
const samples: Sample[] = [];
const jobs: JobResult[] = [];
let publishedPages = 0;
let failure: string | null = null;
const record = (): void => {
  const sample = { elapsedMs: Date.now() - startedAt, rssBytes: rssBytes(server.pid), publishedPages, jobs: jobs.length };
  samples.push(sample);
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
    const pages = totalPages === 0 ? pagesPerJob : Math.min(pagesPerJob, Math.max(2, totalPages - publishedPages));
    {
      const started = await startCrawl(server, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: pages,
        maxDepth: 1,
        concurrency,
        crawlBudget: {
          maxDurationMs: Math.max(600_000, pages * 200),
          maxProviderAttempts: pages * 2,
          maxDocumentBytes: pages * 64_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });
      const terminal = await waitForTerminalCrawl(server, started.id, Math.max(600_000, pages * 200));
      const job: JobResult = {
        id: started.id,
        status: String(terminal.status),
        succeeded: progressCount(terminal, "succeededCount"),
        failed: progressCount(terminal, "failedCount"),
        stopped: progressCount(terminal, "stoppedCount"),
      };
      jobs.push(job);
      publishedPages += job.succeeded + job.failed + job.stopped;
      if (job.status !== "completed" || job.succeeded !== pages) {
        failure = `job ${job.id} ended ${job.status} with ${job.succeeded}/${pages} succeeded pages`;
      }
    }
  }
  record();
} catch (error) {
  failure ??= error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  clearInterval(sampler);
  await server.close().catch(() => undefined);
  await site.close();
  await rm(dataDirectory, { recursive: true, force: true });
}

const quarter = Math.max(1, Math.floor(samples.length / 4));
const earlyRss = median(samples.slice(0, quarter).map((sample) => sample.rssBytes));
const lateRss = median(samples.slice(-quarter).map((sample) => sample.rssBytes));
const rssGrowth = earlyRss === 0 ? 0 : (lateRss - earlyRss) / earlyRss;
if (failure === null && samples.length >= 8 && rssGrowth > maxRssGrowth) {
  failure = `RSS grew ${(rssGrowth * 100).toFixed(1)}% (limit ${(maxRssGrowth * 100).toFixed(0)}%)`;
}
if (failure === null && totalPages > 0 && publishedPages < totalPages) {
  failure = `published ${publishedPages} of ${totalPages} pages before the duration limit`;
}
const elapsedMs = Date.now() - startedAt;
const summary = {
  passed: failure === null,
  failure,
  elapsedMs,
  jobs: jobs.length,
  publishedPages,
  pagesPerSecond: elapsedMs === 0 ? 0 : publishedPages / (elapsedMs / 1_000),
  rss: { earlyMedianBytes: earlyRss, lateMedianBytes: lateRss, growth: rssGrowth, peakBytes: Math.max(...samples.map((sample) => sample.rssBytes)) },
  config: { durationMs, totalPages, pagesPerJob, concurrency, sampleMs, maxRssGrowth },
};
writeFileSync(join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...summary, reportDir }, null, 2)}\n`);
process.exitCode = summary.passed ? 0 : 1;
