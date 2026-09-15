import { describe, expect, it } from "vitest";

import { parseCli } from "../src/cli/main.js";

describe("crawlume CLI", () => {
  it("leaves reader semantic defaults to the shared ReadIntent boundary", () => {
    expect(parseCli(["read", "https://example.com/article"])).toEqual({
      kind: "read",
      markdown: false,
      options: {
        url: "https://example.com/article",
      },
    });
  });

  it("parses cache, profile, age, and Markdown options", () => {
    expect(
      parseCli([
        "read",
        "--cache-mode",
        "live",
        "--max-age-seconds",
        "60",
        "--stale-while-revalidate-seconds",
        "120",
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
        cacheMode: "live",
        maxAgeSeconds: 60,
        staleWhileRevalidateSeconds: 120,
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

  it("parses bounded RSL audit queries", () => {
    expect(parseCli(["extract", "https://example.com/article", "--schema-id", "article-v1"])).toEqual({
      kind: "extract",
      options: {
        url: "https://example.com/article",
        schemaId: "article-v1",
      },
    });
    expect(parseCli(["rsl-audit"])).toEqual({ kind: "rsl-audit", limit: 100 });
    expect(parseCli(["rsl-audit", "--limit", "250"])).toEqual({
      kind: "rsl-audit",
      limit: 250,
    });
  });

  it.each([
    [["read"], "read requires a URL"],
    [["write", "https://example.com"], "Supported commands"],
    [["extract", "--markdown", "https://example.com"], "only for read"],
    [["read", "--schema-id", "article-v1", "https://example.com"], "only for extract"],
    [["read", "--max-age-seconds", "1.5", "https://example.com"], "positive integer"],
    [["read", "--stale-while-revalidate-seconds", "-1", "https://example.com"], "non-negative integer"],
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
    [["rsl-audit", "--limit", "1001"], "between 1 and 1000"],
  ])("rejects invalid arguments", (argv, message) => {
    expect(() => parseCli(argv)).toThrow(message);
  });

  it("supports help without initializing the reader", () => {
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["read", "--help"])).toEqual({ kind: "help" });
  });
});
