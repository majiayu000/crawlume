import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { fetch } from "undici";
import type { RunnerResult } from "../harness/contract.js";
import {
  benchmarkOutcomeForErrorCode,
  executeReaderBenchmarkCase,
  loadBenchmarkCaseSet,
  runBenchmarkCorpus,
  runReaderBenchmarkCaseFile,
} from "../harness/corpus.js";
import { runReadinessTournament } from "../readiness/tournament.js";
import { listen, positiveInteger } from "../harness/runtime.js";

export type ControlledSite = {
  origin: string;
  close(): Promise<void>;
};

export type ControlledSiteOptions = {
  pages: number;
  bodyBytes: number;
};

export type GraphRunnerOptions = {
  seedUrl: string;
  expectedPages: number;
  concurrency: number;
};

type SiteStats = {
  totalRequests: number;
  pageRequests: number;
  requestsByPage: Record<string, number>;
};

function checkedRunnerOptions(options: GraphRunnerOptions): GraphRunnerOptions {
  return {
    seedUrl: new URL(options.seedUrl).toString(),
    expectedPages: positiveInteger(options.expectedPages, "expectedPages"),
    concurrency: positiveInteger(options.concurrency, "concurrency"),
  };
}

function pageIdFor(url: string): string | null {
  return /^\/page\/(\d+)$/u.exec(new URL(url).pathname)?.[1] ?? null;
}

function pageHtml(page: number, pages: number, bodyBytes: number): string {
  const firstChild = page * 4 + 1;
  const links = [firstChild, firstChild + 1, firstChild + 2, firstChild + 3]
    .filter((target) => target < pages)
    .map((target) => `<a href="/page/${target}">page-${target}</a>`)
    .join("");
  const prefix = `<!doctype html><html><head><title>Benchmark page ${page}</title></head><body><main data-benchmark-id="page-${page}"><h1>Benchmark page ${page}</h1><p>BENCHMARK_MARKER_page-${page}</p>${links}<p>`;
  const suffix = "</p></main></body></html>";
  const padding = "x".repeat(Math.max(0, bodyBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)));
  return `${prefix}${padding}${suffix}`;
}

export async function createControlledSite(
  options: ControlledSiteOptions,
): Promise<ControlledSite> {
  const pages = positiveInteger(options.pages, "pages");
  const bodyBytes = positiveInteger(options.bodyBytes, "bodyBytes");
  const stats: SiteStats = { totalRequests: 0, pageRequests: 0, requestsByPage: {} };

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://controlled.test");
    if (requestUrl.pathname === "/__stats") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(stats));
      return;
    }
    if (requestUrl.pathname === "/__reset" && request.method === "POST") {
      stats.totalRequests = 0;
      stats.pageRequests = 0;
      stats.requestsByPage = {};
      response.writeHead(204);
      response.end();
      return;
    }

    const match = /^\/page\/(\d+)$/u.exec(requestUrl.pathname);
    if (match === null) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const rawPage = match[1];
    const page = rawPage === undefined ? Number.NaN : Number.parseInt(rawPage, 10);
    if (!Number.isInteger(page) || page < 0 || page >= pages) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("page out of range");
      return;
    }

    stats.totalRequests += 1;
    stats.pageRequests += 1;
    stats.requestsByPage[String(page)] = (stats.requestsByPage[String(page)] ?? 0) + 1;
    const body = pageHtml(page, pages, bodyBytes);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "text/html; charset=utf-8",
      "x-benchmark-page": String(page),
    });
    response.end(body);
  });

  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    }),
  };
}

export async function runUndiciGraph(rawOptions: GraphRunnerOptions): Promise<RunnerResult> {
  const options = checkedRunnerOptions(rawOptions);
  const origin = new URL(options.seedUrl).origin;
  const scheduled = new Set([options.seedUrl]);
  const responded = new Set<string>();
  const queue = [options.seedUrl];
  let inFlight = 0;
  let validPages = 0;
  let failedPages = 0;
  let duplicateFetches = 0;
  let bytesReceived = 0;
  const startedAt = performance.now();

  await new Promise<void>((resolve, reject) => {
    const schedule = (url: string): void => {
      const normalized = new URL(url).toString();
      if (!scheduled.has(normalized) && scheduled.size < options.expectedPages) {
        scheduled.add(normalized);
        queue.push(normalized);
      }
    };

    const visit = async (url: string): Promise<void> => {
      try {
        const response = await fetch(url, { redirect: "manual" });
        const body = await response.text();
        bytesReceived += Buffer.byteLength(body);
        const finalUrl = new URL(response.url).toString();
        if (responded.has(finalUrl)) {
          duplicateFetches += 1;
          return;
        }
        responded.add(finalUrl);
        const pageId = pageIdFor(finalUrl);
        if (
          response.status === 200 &&
          pageId !== null &&
          response.headers.get("x-benchmark-page") === pageId &&
          body.includes(`BENCHMARK_MARKER_page-${pageId}`)
        ) {
          validPages += 1;
        } else {
          failedPages += 1;
        }
        for (const match of body.matchAll(/href="([^"]+)"/gu)) {
          const href = match[1];
          if (href === undefined) continue;
          const next = new URL(href, finalUrl);
          if (next.origin === origin && /^\/page\/\d+$/u.test(next.pathname)) {
            schedule(next.toString());
          }
        }
      } catch (error) {
        responded.add(url);
        failedPages += 1;
        console.error(error instanceof Error ? error.message : String(error));
      }
    };

    const pump = (): void => {
      while (inFlight < options.concurrency && queue.length > 0) {
        const url = queue.shift();
        if (url === undefined) break;
        inFlight += 1;
        void visit(url).then(() => {
          inFlight -= 1;
          if (queue.length === 0 && inFlight === 0) resolve();
          else pump();
        }, reject);
      }
    };
    pump();
  });

  return {
    protocolVersion: 1,
    runner: "node-undici",
    language: "TypeScript",
    runtime: `Node.js ${process.version}`,
    engine: "Undici",
    seedUrl: options.seedUrl,
    expectedPages: options.expectedPages,
    concurrency: options.concurrency,
    visitedPages: validPages + failedPages,
    validPages,
    failedPages,
    duplicateFetches,
    bytesReceived,
    crawlDurationMs: performance.now() - startedAt,
  };
}

export async function runCrawleeGraph(rawOptions: GraphRunnerOptions): Promise<RunnerResult> {
  const options = checkedRunnerOptions(rawOptions);
  const [{ CheerioCrawler }, { Configuration, LogLevel, log }] = await Promise.all([
    import("@crawlee/cheerio"),
    import("@crawlee/core"),
  ]);
  log.setLevel(LogLevel.OFF);
  const responded = new Set<string>();
  let validPages = 0;
  let failedPages = 0;
  let duplicateFetches = 0;
  let bytesReceived = 0;
  const startedAt = performance.now();
  const crawler = new CheerioCrawler({
    maxConcurrency: options.concurrency,
    minConcurrency: options.concurrency,
    maxRequestRetries: 0,
    maxRequestsPerCrawl: options.expectedPages,
    requestHandlerTimeoutSecs: 30,
    async requestHandler({ request, response, body, $, enqueueLinks }) {
      const finalUrl = new URL(request.loadedUrl ?? request.url).toString();
      if (responded.has(finalUrl)) {
        duplicateFetches += 1;
        return;
      }
      responded.add(finalUrl);
      const textBody = typeof body === "string" ? body : body.toString();
      bytesReceived += Buffer.byteLength(textBody);
      const pageId = pageIdFor(finalUrl);
      if (
        response.statusCode === 200 &&
        pageId !== null &&
        $("main").attr("data-benchmark-id") === `page-${pageId}` &&
        textBody.includes(`BENCHMARK_MARKER_page-${pageId}`)
      ) {
        validPages += 1;
      } else {
        failedPages += 1;
      }
      await enqueueLinks({ strategy: "same-origin" });
    },
    failedRequestHandler({ request }, error) {
      responded.add(request.url);
      failedPages += 1;
      console.error(error instanceof Error ? error.message : String(error));
    },
  }, new Configuration({ persistStorage: false }));

  await crawler.run([options.seedUrl]);
  return {
    protocolVersion: 1,
    runner: "node-crawlee",
    language: "TypeScript",
    runtime: `Node.js ${process.version}`,
    engine: "Crawlee CheerioCrawler 3.16.0",
    seedUrl: options.seedUrl,
    expectedPages: options.expectedPages,
    concurrency: options.concurrency,
    visitedPages: validPages + failedPages,
    validPages,
    failedPages,
    duplicateFetches,
    bytesReceived,
    crawlDurationMs: performance.now() - startedAt,
  };
}

function cliOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function cliPositiveInteger(name: string): number {
  const value = Number.parseInt(cliOption(name) ?? "", 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

export { benchmarkOutcomeForErrorCode };

async function runCli(): Promise<void> {
  const runner = cliOption("runner");
  if (runner === "readiness-tournament") {
    const repeats = Number.parseInt(cliOption("repeats") ?? "5", 10);
    const report = await runReadinessTournament(repeats);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const target = report.summaries.find((summary) => summary.strategy === "target");
    if (target?.validRate !== 1 || target.falseSuccesses !== 0) process.exitCode = 2;
    return;
  }
  if (runner === "reader-case") {
    const casePath = cliOption("case");
    if (casePath === undefined) throw new Error("--case is required for reader-case");
    const report = await runReaderBenchmarkCaseFile(casePath);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.evaluation.passed) process.exitCode = 2;
    return;
  }
  if (runner === "reader-corpus") {
    const root = resolve(".");
    const casesDirectory = resolve(cliOption("cases") ?? resolve(root, "benchmarks/cases"));
    const caseSet = await loadBenchmarkCaseSet(casesDirectory);
    const report = await runBenchmarkCorpus(caseSet, executeReaderBenchmarkCase);
    const reportsDirectory = resolve(root, "benchmarks/reports");
    await mkdir(reportsDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        resolve(reportsDirectory, "corpus-latest.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        resolve(reportsDirectory, "corpus-latest.jsonl"),
        `${report.runs.map((run) => JSON.stringify(run)).join("\n")}\n`,
        "utf8",
      ),
    ]);
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    if (
      report.summary.truthPassedRuns !== report.summary.measuredRuns ||
      report.summary.outcomes.harnessError !== 0
    ) process.exitCode = 2;
    return;
  }
  const seedUrl = cliOption("seed");
  if (seedUrl === undefined) throw new Error("--seed is required");
  const options: GraphRunnerOptions = {
    seedUrl,
    expectedPages: cliPositiveInteger("pages"),
    concurrency: cliPositiveInteger("concurrency"),
  };
  const result = runner === "node-undici"
    ? await runUndiciGraph(options)
    : runner === "node-crawlee"
      ? await runCrawleeGraph(options)
      : null;
  if (result === null) {
    throw new Error(
      "--runner must be readiness-tournament, reader-case, reader-corpus, node-undici, or node-crawlee",
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  void runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
