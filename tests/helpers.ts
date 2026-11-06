import type { LookupAddress } from "node:dns";

import type { AppConfig } from "../src/config.js";
import type { PageFetcher, RawPage } from "../src/types.js";

export function testConfig(): AppConfig {
  return {
    dataDir: "/tmp/crawlume-test",
    cachePath: ":memory:",
    profilesDir: "/tmp/crawlume-test/profiles",
    userAgent: "CrawlumeTest/0.1",
    agentIdentityUrl: null,
    webBotAuthJwkPath: null,
    webBotAuthProfile: "cloudflare-legacy",
    webBotAuthTtlSeconds: 60,
    rslUsage: "ai-input",
    rslUserClass: null,
    rslGeo: null,
    rslApprovalsPath: "/tmp/crawlume-test/rsl-approvals.json",
    rslClientsPath: "/tmp/crawlume-test/rsl-clients.json",
    requestTimeoutMs: 2_000,
    browserTimeoutMs: 2_000,
    maxResponseBytes: 1_000_000,
    maxRedirects: 3,
    robotsCacheSeconds: 60,
    defaultCacheSeconds: 900,
    crawlMaxAttempts: 3,
    crawlRetryBaseMs: 0,
    crawlMaxRetryDelayMs: 1_000,
    crawlMinHostIntervalMs: 0,
    crawlWorkerConcurrency: 8,
    crawlLeaseMs: 5_000,
    browserPoolSize: 2,
    browserContextsPerInstance: 4,
    browserPoolWaitMs: 1_000,
    browserChannel: "chrome",
    browserExecutable: null,
    allowDnsFakeIp: false,
    localIndexEnabled: false,
    proxyEndpoints: [],
    searxngUrl: null,
    telemetry: null,
  };
}

export function publicResolver(): LookupAddress[] {
  return [{ address: "93.184.216.34", family: 4 }];
}

export function rawPage(overrides: Partial<RawPage> = {}): RawPage {
  const paragraph = "A complete article contains concrete evidence, context, and enough detail for an agent to reason from the source safely. ";
  const body = `<html><head><title>Example article</title></head><body><main><h1>Example article</h1><p>${paragraph.repeat(5)}</p></main></body></html>`;
  return {
    body,
    fetchedAt: new Date().toISOString(),
    method: "http",
    httpStatus: 200,
    contentType: "text/html; charset=utf-8",
    responseBytes: Buffer.byteLength(body),
    finalUrl: "https://example.com/article",
    ...overrides,
  };
}

export class StubFetcher implements PageFetcher {
  calls = 0;

  constructor(private readonly response: RawPage | Error) {}

  async fetch(): Promise<RawPage> {
    this.calls += 1;
    if (this.response instanceof Error) {
      throw this.response;
    }
    return this.response;
  }
}

// DROP DATABASE ... WITH (FORCE) terminates idle test connections with 57P01; collect anything else.
export function trackPoolErrors<T extends { on(event: "error", listener: (error: Error) => void): unknown }>(
  pool: T,
  unexpected: unknown[],
): T {
  pool.on("error", (error) => {
    if ((error as { code?: string }).code !== "57P01") unexpected.push(error);
  });
  return pool;
}
