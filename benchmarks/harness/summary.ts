import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createControlledSite } from "../controlled-site/server.js";
import { parseRunnerStdout, type RunnerResult } from "./contract.js";

export type MeasuredRun = {
  result: RunnerResult;
  wallDurationMs: number;
  maxRssBytes: number;
  userCpuSeconds?: number;
  systemCpuSeconds?: number;
};

export type DarwinTimeMetrics = {
  wallDurationMs: number;
  userCpuSeconds: number;
  systemCpuSeconds: number;
  maxRssBytes: number;
};

export type RunnerSummary = {
  runner: string;
  language: string;
  runtime: string;
  engine: string;
  rounds: number;
  allRunsComplete: boolean;
  medianCrawlDurationMs: number;
  medianWallDurationMs: number;
  medianMaxRssBytes: number;
  medianPagesPerSecond: number;
};

type RunnerCommand = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
};

type BenchmarkReport = {
  protocolVersion: 1;
  generatedAt: string;
  environment: {
    platform: string;
    release: string;
    architecture: string;
    cpuModel: string;
    logicalCpus: number;
    totalMemoryBytes: number;
    node: string;
  };
  workload: {
    pages: number;
    bodyBytes: number;
    concurrency: number;
    warmups: number;
    rounds: number;
  };
  runs: MeasuredRun[];
  summaries: RunnerSummary[];
};

const scrapyRunner = String.raw`
import argparse, json, platform, re, sys, time
from urllib.parse import urlparse
import scrapy
from scrapy.crawler import CrawlerProcess

class BenchmarkSpider(scrapy.Spider):
    name = "diaoyan_benchmark"
    def __init__(self, seed_url, expected_pages, concurrency, **kwargs):
        super().__init__(**kwargs)
        self.seed_url = seed_url
        self.expected_pages = expected_pages
        self.concurrency = concurrency
        self.responded = set()
        self.valid_pages = 0
        self.failed_pages = 0
        self.duplicate_fetches = 0
        self.bytes_received = 0
        self.started_at = 0.0
    async def start(self):
        self.started_at = time.perf_counter()
        yield scrapy.Request(self.seed_url, callback=self.parse_page, errback=self.on_error)
    def parse_page(self, response):
        if response.url in self.responded:
            self.duplicate_fetches += 1
            return
        self.responded.add(response.url)
        self.bytes_received += len(response.body)
        match = re.fullmatch(r"/page/(\d+)", urlparse(response.url).path)
        page_id = match.group(1) if match else None
        benchmark_id = response.css("main::attr(data-benchmark-id)").get()
        marker = f"BENCHMARK_MARKER_page-{page_id}" if page_id is not None else ""
        if response.status == 200 and page_id is not None and benchmark_id == f"page-{page_id}" and marker in response.text:
            self.valid_pages += 1
        else:
            self.failed_pages += 1
        for href in response.css("a::attr(href)").getall():
            yield response.follow(href, callback=self.parse_page, errback=self.on_error)
    def on_error(self, failure):
        request_url = failure.request.url
        if request_url not in self.responded:
            self.responded.add(request_url)
            self.failed_pages += 1
        print(str(failure.value), file=sys.stderr)
    def closed(self, reason):
        print(json.dumps({
            "protocolVersion": 1,
            "runner": "python-scrapy",
            "language": "Python",
            "runtime": f"CPython {platform.python_version()}",
            "engine": f"Scrapy {scrapy.__version__}",
            "seedUrl": self.seed_url,
            "expectedPages": self.expected_pages,
            "concurrency": self.concurrency,
            "visitedPages": self.valid_pages + self.failed_pages,
            "validPages": self.valid_pages,
            "failedPages": self.failed_pages,
            "duplicateFetches": self.duplicate_fetches,
            "bytesReceived": self.bytes_received,
            "crawlDurationMs": (time.perf_counter() - self.started_at) * 1000,
        }, separators=(",", ":")))

def positive(value):
    parsed = int(value)
    if parsed < 1: raise argparse.ArgumentTypeError("must be positive")
    return parsed

parser = argparse.ArgumentParser()
parser.add_argument("--seed", required=True)
parser.add_argument("--pages", required=True, type=positive)
parser.add_argument("--concurrency", required=True, type=positive)
args = parser.parse_args()
process = CrawlerProcess(settings={
    "CONCURRENT_REQUESTS": args.concurrency,
    "CONCURRENT_REQUESTS_PER_DOMAIN": args.concurrency,
    "COOKIES_ENABLED": False,
    "DOWNLOAD_TIMEOUT": 30,
    "LOG_ENABLED": False,
    "RETRY_ENABLED": False,
    "ROBOTSTXT_OBEY": False,
    "TELNETCONSOLE_ENABLED": False,
})
process.crawl(BenchmarkSpider, seed_url=args.seed, expected_pages=args.pages, concurrency=args.concurrency)
process.start()
`;

const collyGoMod = `module diaoyan-benchmark-colly\n\ngo 1.25.0\n\nrequire github.com/gocolly/colly/v2 v2.3.0\n`;

const collyRunner = String.raw`
package main
import (
  "encoding/json"
  "errors"
  "flag"
  "fmt"
  "net/url"
  "os"
  "runtime"
  "strconv"
  "strings"
  "sync"
  "time"
  "github.com/gocolly/colly/v2"
)
type result struct {
  ProtocolVersion int ` + "`json:\"protocolVersion\"`" + `
  Runner string ` + "`json:\"runner\"`" + `
  Language string ` + "`json:\"language\"`" + `
  Runtime string ` + "`json:\"runtime\"`" + `
  Engine string ` + "`json:\"engine\"`" + `
  SeedURL string ` + "`json:\"seedUrl\"`" + `
  ExpectedPages int ` + "`json:\"expectedPages\"`" + `
  Concurrency int ` + "`json:\"concurrency\"`" + `
  VisitedPages int ` + "`json:\"visitedPages\"`" + `
  ValidPages int ` + "`json:\"validPages\"`" + `
  FailedPages int ` + "`json:\"failedPages\"`" + `
  DuplicateFetches int ` + "`json:\"duplicateFetches\"`" + `
  BytesReceived int ` + "`json:\"bytesReceived\"`" + `
  CrawlDurationMS float64 ` + "`json:\"crawlDurationMs\"`" + `
}
func main() {
  seed := flag.String("seed", "", "seed URL")
  pages := flag.Int("pages", 0, "expected pages")
  concurrency := flag.Int("concurrency", 0, "concurrency")
  flag.Parse()
  if *seed == "" || *pages < 1 || *concurrency < 1 { panic("invalid arguments") }
  parsed, err := url.Parse(*seed)
  if err != nil { panic(err) }
  collector := colly.NewCollector(colly.Async(true), colly.AllowedDomains(parsed.Hostname()))
  if err := collector.Limit(&colly.LimitRule{DomainGlob: "*", Parallelism: *concurrency}); err != nil { panic(err) }
  var lock sync.Mutex
  responded := make(map[string]struct{})
  valid, failed, duplicates, bytes := 0, 0, 0, 0
  collector.OnResponse(func(response *colly.Response) {
    lock.Lock()
    defer lock.Unlock()
    requestURL := response.Request.URL.String()
    if _, exists := responded[requestURL]; exists { duplicates++; return }
    responded[requestURL] = struct{}{}
    bytes += len(response.Body)
    parts := strings.Split(strings.Trim(response.Request.URL.Path, "/"), "/")
    pageID := ""
    if len(parts) == 2 && parts[0] == "page" {
      if _, parseErr := strconv.Atoi(parts[1]); parseErr == nil { pageID = parts[1] }
    }
    if response.StatusCode == 200 && pageID != "" && strings.Contains(string(response.Body), "BENCHMARK_MARKER_page-"+pageID) { valid++ } else { failed++ }
  })
  collector.OnHTML("a[href]", func(element *colly.HTMLElement) {
    visitErr := element.Request.Visit(element.Attr("href"))
    var alreadyVisited *colly.AlreadyVisitedError
    if visitErr != nil && !errors.As(visitErr, &alreadyVisited) { fmt.Fprintln(os.Stderr, visitErr) }
  })
  collector.OnError(func(response *colly.Response, crawlErr error) {
    lock.Lock()
    defer lock.Unlock()
    requestURL := response.Request.URL.String()
    if _, exists := responded[requestURL]; !exists { responded[requestURL] = struct{}{}; failed++ }
    fmt.Fprintln(os.Stderr, crawlErr)
  })
  started := time.Now()
  if err := collector.Visit(parsed.String()); err != nil { panic(err) }
  collector.Wait()
  output := result{1, "go-colly", "Go", runtime.Version(), "Colly v2.3.0", parsed.String(), *pages, *concurrency, valid+failed, valid, failed, duplicates, bytes, float64(time.Since(started).Microseconds())/1000}
  if err := json.NewEncoder(os.Stdout).Encode(output); err != nil { panic(err) }
}
`;

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("cannot calculate a median without values");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const middle = sorted[midpoint];
  if (middle === undefined) {
    throw new Error("median input unexpectedly had no midpoint");
  }
  if (sorted.length % 2 === 1) {
    return middle;
  }
  const previous = sorted[midpoint - 1];
  if (previous === undefined) {
    throw new Error("median input unexpectedly had no lower midpoint");
  }
  return (previous + middle) / 2;
}

export function parseDarwinTimeMetrics(output: string): DarwinTimeMetrics {
  const duration = /([0-9.]+)\s+real\s+([0-9.]+)\s+user\s+([0-9.]+)\s+sys/u.exec(output);
  const memory = /(\d+)\s+maximum resident set size/u.exec(output);
  const realSeconds = Number.parseFloat(duration?.[1] ?? "");
  const userCpuSeconds = Number.parseFloat(duration?.[2] ?? "");
  const systemCpuSeconds = Number.parseFloat(duration?.[3] ?? "");
  const maxRssBytes = Number.parseInt(memory?.[1] ?? "", 10);
  if (
    !Number.isFinite(realSeconds) ||
    !Number.isFinite(userCpuSeconds) ||
    !Number.isFinite(systemCpuSeconds) ||
    !Number.isSafeInteger(maxRssBytes)
  ) {
    throw new Error("Darwin time output did not contain complete resource metrics");
  }
  return {
    wallDurationMs: realSeconds * 1_000,
    userCpuSeconds,
    systemCpuSeconds,
    maxRssBytes,
  };
}

export function summarizeRuns(runs: MeasuredRun[]): RunnerSummary {
  const first = runs[0];
  if (first === undefined) {
    throw new Error("at least one measured run is required");
  }
  if (runs.some(({ result }) => result.runner !== first.result.runner)) {
    throw new Error("all measured runs in a summary must use the same runner");
  }
  return {
    runner: first.result.runner,
    language: first.result.language,
    runtime: first.result.runtime,
    engine: first.result.engine,
    rounds: runs.length,
    allRunsComplete: runs.every(({ result }) =>
      result.visitedPages === result.expectedPages &&
      result.validPages === result.expectedPages &&
      result.failedPages === 0
    ),
    medianCrawlDurationMs: median(runs.map(({ result }) => result.crawlDurationMs)),
    medianWallDurationMs: median(runs.map(({ wallDurationMs }) => wallDurationMs)),
    medianMaxRssBytes: median(runs.map(({ maxRssBytes }) => maxRssBytes)),
    medianPagesPerSecond: median(runs.map(({ result }) =>
      result.crawlDurationMs === 0
        ? Number.POSITIVE_INFINITY
        : result.validPages / (result.crawlDurationMs / 1_000)
    )),
  };
}

async function executeTimed(command: RunnerCommand): Promise<MeasuredRun> {
  const startedAt = performance.now();
  const child = spawn("/usr/bin/time", ["-l", command.command, ...command.args], {
    cwd: command.cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  if (exitCode !== 0) {
    throw new Error(`${command.name} exited with ${exitCode}: ${stderr.trim()}`);
  }
  const result = parseRunnerStdout(stdout);
  if (result.runner !== command.name) {
    throw new Error(`${command.name} returned runner=${result.runner}`);
  }
  const metrics = parseDarwinTimeMetrics(stderr);
  return {
    result,
    wallDurationMs: Math.max(metrics.wallDurationMs, performance.now() - startedAt),
    maxRssBytes: metrics.maxRssBytes,
    userCpuSeconds: metrics.userCpuSeconds,
    systemCpuSeconds: metrics.systemCpuSeconds,
  };
}

async function runSetup(command: string, args: string[], cwd: string): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(stderr || stdout).trim()}`);
  }
}

async function prepareCollyRunner(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "diaoyan-colly-"));
  const binary = resolve(directory, "colly-runner");
  try {
    await Promise.all([
      writeFile(resolve(directory, "go.mod"), collyGoMod, "utf8"),
      writeFile(resolve(directory, "main.go"), collyRunner, "utf8"),
    ]);
    await runSetup("go", ["mod", "tidy"], directory);
    await runSetup("go", ["build", "-trimpath", "-o", binary, "."], directory);
    return {
      path: binary,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function cliInteger(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const raw = index === -1 ? String(fallback) : process.argv[index + 1] ?? "";
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

async function resetSite(origin: string): Promise<void> {
  const response = await fetch(`${origin}/__reset`, { method: "POST" });
  if (response.status !== 204) {
    throw new Error(`controlled site reset failed with HTTP ${response.status}`);
  }
}

async function assertServerCount(origin: string, expected: number, runner: string): Promise<void> {
  const response = await fetch(`${origin}/__stats`);
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("pageRequests" in value) ||
    value.pageRequests !== expected
  ) {
    throw new Error(`${runner} made an unexpected number of controlled-site page requests`);
  }
}

async function runBenchmarkCli(): Promise<void> {
  const pages = cliInteger("pages", 1_000);
  const bodyBytes = cliInteger("body-bytes", 8_192);
  const concurrency = cliInteger("concurrency", 32);
  const warmups = cliInteger("warmups", 1);
  const rounds = cliInteger("rounds", 5);
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(currentDir, "../..");
  const runnerEntry = resolve(root, "benchmarks/controlled-site/server.ts");
  const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
  const colly = await prepareCollyRunner();
  const site = await createControlledSite({ pages, bodyBytes });
  const seedUrl = `${site.origin}/page/0`;
  const baseArgs = [runnerEntry, "--seed", seedUrl, "--pages", String(pages), "--concurrency", String(concurrency)];
  const commands: RunnerCommand[] = ["node-undici", "node-crawlee"].map((name) => ({
    name,
    command: process.execPath,
    args: [tsxCli, ...baseArgs, "--runner", name],
    cwd: root,
  }));
  commands.push({
    name: "python-scrapy",
    command: "uvx",
    args: [
      "--from", "scrapy==2.16.0", "python", "-c", scrapyRunner,
      "--seed", seedUrl, "--pages", String(pages), "--concurrency", String(concurrency),
    ],
    cwd: root,
  }, {
    name: "go-colly",
    command: colly.path,
    args: ["--seed", seedUrl, "--pages", String(pages), "--concurrency", String(concurrency)],
    cwd: root,
  });
  const runs: MeasuredRun[] = [];
  try {
    for (const command of commands) {
      for (let round = 0; round < warmups + rounds; round += 1) {
        await resetSite(site.origin);
        const measured = await executeTimed(command);
        await assertServerCount(site.origin, pages + measured.result.duplicateFetches, command.name);
        if (round >= warmups) runs.push(measured);
      }
    }
  } finally {
    await site.close();
    await colly.cleanup();
  }
  const summaries = commands.map(({ name }) => summarizeRuns(
    runs.filter(({ result }) => result.runner === name),
  ));
  const cpu = cpus();
  const report: BenchmarkReport = {
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpuModel: cpu[0]?.model ?? "unknown",
      logicalCpus: cpu.length,
      totalMemoryBytes: totalmem(),
      node: process.version,
    },
    workload: { pages, bodyBytes, concurrency, warmups, rounds },
    runs,
    summaries,
  };
  const reportsDir = resolve(root, "benchmarks/reports");
  await mkdir(reportsDir, { recursive: true });
  await writeFile(resolve(reportsDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report.summaries, null, 2)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  void runBenchmarkCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
