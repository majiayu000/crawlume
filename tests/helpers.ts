import type { LookupAddress } from "node:dns";

import type { AppConfig } from "../src/config.js";
import type { PageFetcher, RawPage } from "../src/types.js";

export function testConfig(): AppConfig {
  return {
    dataDir: "/tmp/diaoyan-test",
    cachePath: ":memory:",
    profilesDir: "/tmp/diaoyan-test/profiles",
    userAgent: "DiaoyanWebReaderTest/0.1",
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
    browserChannel: "chrome",
    browserExecutable: null,
    allowDnsFakeIp: false,
    localIndexEnabled: false,
    proxyEndpoints: [],
    searxngUrl: null,
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
    fetchedAt: "2026-08-24T00:00:00.000Z",
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
