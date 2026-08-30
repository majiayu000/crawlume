import type { CallToolResult } from "@modelcontextprotocol/client";

import type { BuiltMcpProcess } from "./mcp-process.js";

export type JsonRecord = Record<string, unknown>;

export type CrawlPagePublication = JsonRecord & {
  publicationSequence: number;
};

export type CrawlPageBatch = JsonRecord & {
  jobId: string;
  pages: CrawlPagePublication[];
  nextSequence: number;
  done: boolean;
};

function resultText(result: CallToolResult): string {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => {
      return item.type === "text";
    })
    .map((item) => item.text)
    .join("\n");
}

export function requireStructuredResult(result: CallToolResult, tool: string): JsonRecord {
  if (result.isError === true) {
    throw new Error(`${tool} returned an MCP error: ${resultText(result)}`);
  }
  const value = result.structuredContent;
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${tool} did not return structured object content`);
  }
  return value as JsonRecord;
}

function requiredString(value: JsonRecord, field: string, source: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`${source} returned invalid ${field}`);
  }
  return fieldValue;
}

function requiredNumber(value: JsonRecord, field: string, source: string): number {
  const fieldValue = value[field];
  if (!Number.isSafeInteger(fieldValue)) {
    throw new Error(`${source} returned invalid ${field}`);
  }
  return fieldValue as number;
}

function requiredBoolean(value: JsonRecord, field: string, source: string): boolean {
  const fieldValue = value[field];
  if (typeof fieldValue !== "boolean") {
    throw new Error(`${source} returned invalid ${field}`);
  }
  return fieldValue;
}

function waitForNextObservation(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function startCrawl(
  process: BuiltMcpProcess,
  args: Record<string, unknown>,
): Promise<JsonRecord & { id: string }> {
  const started = requireStructuredResult(await process.callTool("start_crawl", args), "start_crawl");
  return { ...started, id: requiredString(started, "id", "start_crawl") };
}

export async function getCrawl(
  process: BuiltMcpProcess,
  jobId: string,
): Promise<JsonRecord> {
  return requireStructuredResult(
    await process.callTool("get_crawl", { jobId }),
    "get_crawl",
  );
}

export async function waitForCrawl(
  process: BuiltMcpProcess,
  jobId: string,
  predicate: (job: JsonRecord) => boolean,
  options: { timeoutMs?: number; description?: string } = {},
): Promise<JsonRecord> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let intervalMs = 10;
  let last: JsonRecord | null = null;
  while (Date.now() <= deadline) {
    last = await getCrawl(process, jobId);
    if (predicate(last)) return last;
    await waitForNextObservation(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    intervalMs = Math.min(200, intervalMs * 2);
  }
  const description = options.description ?? "crawl predicate";
  throw new Error(
    `timed out waiting for ${description}; last crawl snapshot: ${JSON.stringify(last)}`,
  );
}

export function waitForTerminalCrawl(
  process: BuiltMcpProcess,
  jobId: string,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  return waitForCrawl(
    process,
    jobId,
    (job) => ["completed", "failed", "cancelled"].includes(String(job.status)),
    { timeoutMs, description: "a terminal crawl status" },
  );
}

export async function getCrawlPageBatch(
  process: BuiltMcpProcess,
  jobId: string,
  afterSequence: number,
  limit: number,
): Promise<CrawlPageBatch> {
  const value = requireStructuredResult(
    await process.callTool("get_crawl_pages", { jobId, afterSequence, limit }),
    "get_crawl_pages",
  );
  if (!Array.isArray(value.pages)) {
    throw new Error("get_crawl_pages returned invalid pages");
  }
  const pages = value.pages.map((page, index) => {
    if (page === null || Array.isArray(page) || typeof page !== "object") {
      throw new Error(`get_crawl_pages returned invalid pages[${index}]`);
    }
    const record = page as JsonRecord;
    return {
      ...record,
      publicationSequence: requiredNumber(
        record,
        "publicationSequence",
        `get_crawl_pages pages[${index}]`,
      ),
    };
  });
  return {
    ...value,
    jobId: requiredString(value, "jobId", "get_crawl_pages"),
    pages,
    nextSequence: requiredNumber(value, "nextSequence", "get_crawl_pages"),
    done: requiredBoolean(value, "done", "get_crawl_pages"),
  };
}

export async function collectCrawlPages(
  process: BuiltMcpProcess,
  jobId: string,
  limit = 100,
): Promise<CrawlPagePublication[]> {
  const pages: CrawlPagePublication[] = [];
  let afterSequence = 0;
  for (;;) {
    const batch = await getCrawlPageBatch(process, jobId, afterSequence, limit);
    if (batch.jobId !== jobId) {
      throw new Error(`get_crawl_pages returned jobId ${batch.jobId} for ${jobId}`);
    }
    pages.push(...batch.pages);
    if (batch.done) return pages;
    if (batch.nextSequence <= afterSequence) {
      throw new Error("get_crawl_pages cursor did not advance before done=false");
    }
    afterSequence = batch.nextSequence;
  }
}
