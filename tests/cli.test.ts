import { describe, expect, it } from "vitest";

import { parseCli } from "../src/cli/main.js";

describe("diaoyan CLI", () => {
  it("parses a read command with machine-friendly defaults", () => {
    expect(parseCli(["read", "https://example.com/article"])).toEqual({
      kind: "read",
      markdown: false,
      options: {
        url: "https://example.com/article",
        mode: "auto",
        cacheMode: "prefer-cache",
        maxAgeSeconds: 900,
      },
    });
  });

  it("parses browser, cache, profile, age, and Markdown options", () => {
    expect(
      parseCli([
        "read",
        "--mode",
        "browser",
        "--cache-mode",
        "live",
        "--max-age-seconds",
        "60",
        "--auth-profile",
        "research",
        "--markdown",
        "https://example.com/article",
      ]),
    ).toEqual({
      kind: "read",
      markdown: true,
      options: {
        url: "https://example.com/article",
        mode: "browser",
        cacheMode: "live",
        maxAgeSeconds: 60,
        authProfile: "research",
      },
    });
  });

  it("parses bounded map options", () => {
    expect(
      parseCli([
        "map",
        "https://example.com/docs",
        "--max-pages",
        "12",
        "--max-depth",
        "3",
        "--include-subdomains",
        "--keep-query",
      ]),
    ).toEqual({
      kind: "map",
      options: {
        url: "https://example.com/docs",
        mode: "auto",
        maxPages: 12,
        maxDepth: 3,
        includeSubdomains: true,
        ignoreQueryParameters: false,
      },
    });
  });

  it("parses crawl with reader and site defaults", () => {
    expect(parseCli(["crawl", "https://example.com/docs"])).toEqual({
      kind: "crawl",
      options: {
        url: "https://example.com/docs",
        mode: "auto",
        cacheMode: "prefer-cache",
        maxAgeSeconds: 900,
        maxPages: 10,
        maxDepth: 2,
        includeSubdomains: false,
        ignoreQueryParameters: true,
      },
    });
  });

  it("parses a multi-word search query and provider options", () => {
    expect(
      parseCli([
        "search",
        "MiniMax",
        "H3",
        "推理优化",
        "--limit",
        "6",
        "--language",
        "zh-CN",
        "--safe-search",
        "2",
        "--time-range",
        "month",
      ]),
    ).toEqual({
      kind: "search",
      options: {
        query: "MiniMax H3 推理优化",
        limit: 6,
        page: 1,
        language: "zh-CN",
        safeSearch: 2,
        timeRange: "month",
        source: "auto",
      },
    });
  });

  it("selects local-only search", () => {
    expect(parseCli(["search", "inference", "--source", "local"])).toMatchObject({
      kind: "search",
      options: { query: "inference", source: "local" },
    });
  });

  it("parses crawler statistics with a bounded UTC day window", () => {
    expect(parseCli(["stats"])).toEqual({ kind: "stats", days: 7 });
    expect(parseCli(["stats", "--days", "30"])).toEqual({ kind: "stats", days: 30 });
  });

  it.each([
    [["read"], "read requires a URL"],
    [["write", "https://example.com"], "Supported commands"],
    [["read", "--mode", "magic", "https://example.com"], "unsupported value"],
    [["read", "--max-age-seconds", "1.5", "https://example.com"], "positive integer"],
    [["read", "--unknown", "https://example.com"], "Unknown command-line option"],
    [["read", "https://one.example", "https://two.example"], "exactly one URL"],
    [["map", "--max-pages", "501", "https://example.com"], "between 1 and 500"],
    [["crawl", "--max-depth", "11", "https://example.com"], "between 0 and 10"],
    [["map", "--markdown", "https://example.com"], "only for read"],
    [["search"], "requires a query"],
    [["search", "query", "--limit", "21"], "between 1 and 20"],
    [["search", "query", "--time-range", "week"], "unsupported value"],
    [["search", "query", "--source", "remote"], "unsupported value"],
    [["stats", "--days", "0"], "between 1 and 90"],
    [["stats", "unexpected"], "Unknown stats option"],
  ])("rejects invalid arguments", (argv, message) => {
    expect(() => parseCli(argv)).toThrow(message);
  });

  it("supports help without initializing the reader", () => {
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["read", "--help"])).toEqual({ kind: "help" });
  });
});
