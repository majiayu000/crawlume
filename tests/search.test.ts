import { describe, expect, it, vi } from "vitest";

import { SearchService, SearxngProvider } from "../src/search.js";
import { LocalPageIndex } from "../src/index.js";
import type { SearchRequester } from "../src/search.js";
import type { PageReadArtifact, SearchWebResult } from "../src/types.js";

function jsonResponse(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  return {
    status,
    contentType: "application/json",
    body,
    responseBytes: Buffer.byteLength(body),
  };
}

describe("SearchService", () => {
  it("fails visibly when no provider is configured", async () => {
    await expect(new SearchService(null).searchWeb({ query: "MiniMax H3" })).rejects.toMatchObject({
      code: "SEARCH_PROVIDER_NOT_CONFIGURED",
    });
  });

  it("validates bounded search options before calling the provider", async () => {
    const provider = { name: "test", search: vi.fn() };
    const service = new SearchService(provider);
    await expect(service.searchWeb({ query: " ", limit: 30 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(provider.search).not.toHaveBeenCalled();
  });

  it("searches the local index without a web provider", async () => {
    const index = new LocalPageIndex(":memory:");
    index.put(indexedPage());
    try {
      const result = await new SearchService(null, index).searchWeb({
        query: "MiniMax H3",
        source: "local",
      });
      expect(result).toMatchObject({
        status: "ok",
        provider: "local",
        results: [{ source: "local", url: "https://example.com/h3" }],
        warnings: [],
      });
    } finally {
      index.close();
    }
  });

  it("prefers local results and fills from the web without duplicate URLs", async () => {
    const index = new LocalPageIndex(":memory:");
    index.put(indexedPage());
    const provider = {
      name: "test-web",
      search: vi.fn(async (): Promise<SearchWebResult> => webResult()),
    };
    try {
      const result = await new SearchService(provider, index).searchWeb({
        query: "MiniMax H3",
        limit: 3,
      });
      expect(result.provider).toBe("local+test-web");
      expect(result.results.map(({ url }) => url)).toEqual([
        "https://example.com/h3",
        "https://example.com/other",
      ]);
      expect(result.results[0]?.source).toBe("local");
    } finally {
      index.close();
    }
  });

  it("reports partial results when web fill fails after a local match", async () => {
    const index = new LocalPageIndex(":memory:");
    index.put(indexedPage());
    const provider = {
      name: "broken-web",
      search: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    try {
      const result = await new SearchService(provider, index).searchWeb({
        query: "MiniMax H3",
        limit: 3,
      });
      expect(result).toMatchObject({
        status: "partial",
        provider: "local+broken-web",
        warnings: [{ code: "SEARCH_PROVIDER_ERROR", retryable: true }],
      });
    } finally {
      index.close();
    }
  });
});

describe("SearxngProvider", () => {
  it("maps search parameters and normalizes deduplicated results", async () => {
    const requester = vi.fn<SearchRequester>(async () =>
      jsonResponse({
        number_of_results: 42,
        results: [
          {
            url: "https://example.com/h3#details",
            title: "<b>MiniMax H3</b>",
            content: "Fast <em>inference</em>",
            engines: ["bing", "google"],
            score: 3.5,
            publishedDate: "2026-07-31T00:00:00Z",
            thumbnail: "https://example.com/h3.png",
          },
          {
            url: "https://example.com/h3",
            title: "duplicate",
            content: "duplicate",
            engine: "bing",
          },
          {
            url: "https://example.com/guide",
            title: "Guide",
            content: null,
            engine: "brave",
          },
        ],
      }),
    );
    const provider = new SearxngProvider(
      "http://127.0.0.1:8080/searxng",
      "DiaoyanTest/1.0",
      1_000,
      requester,
    );

    const result = await new SearchService(provider).searchWeb({
      query: "  MiniMax   H3  ",
      limit: 10,
      page: 2,
      language: "zh-CN",
      safeSearch: 2,
      timeRange: "month",
    });

    const requestedUrl = requester.mock.calls[0]?.[0];
    expect(requestedUrl?.pathname).toBe("/searxng/search");
    expect(Object.fromEntries(requestedUrl?.searchParams ?? [])).toMatchObject({
      q: "MiniMax H3",
      format: "json",
      categories: "general",
      language: "zh-CN",
      pageno: "2",
      safesearch: "2",
      time_range: "month",
    });
    expect(result).toMatchObject({
      status: "ok",
      query: "MiniMax H3",
      provider: "searxng",
      page: 2,
      totalResults: 42,
    });
    expect(result.results).toEqual([
      {
        title: "MiniMax H3",
        url: "https://example.com/h3",
        snippet: "Fast inference",
        source: "web",
        engines: ["bing", "google"],
        score: 3.5,
        publishedAt: "2026-07-31T00:00:00Z",
        thumbnailUrl: "https://example.com/h3.png",
      },
      {
        title: "Guide",
        url: "https://example.com/guide",
        snippet: "",
        source: "web",
        engines: ["brave"],
        score: null,
        publishedAt: null,
        thumbnailUrl: null,
      },
    ]);
  });

  it("explains when the instance has JSON output disabled", async () => {
    const requester: SearchRequester = async () => ({
      status: 403,
      contentType: "text/html",
      body: "Forbidden",
      responseBytes: 9,
    });
    const provider = new SearxngProvider("http://127.0.0.1:8080", "test", 1_000, requester);

    await expect(new SearchService(provider).searchWeb({ query: "test" })).rejects.toMatchObject({
      code: "SEARCH_PROVIDER_ERROR",
      message: expect.stringContaining("enable the json format"),
    });
  });

  it("rejects malformed provider responses", async () => {
    const requester: SearchRequester = async () => jsonResponse({ results: "not-an-array" });
    const provider = new SearxngProvider("http://127.0.0.1:8080", "test", 1_000, requester);

    await expect(new SearchService(provider).searchWeb({ query: "test" })).rejects.toMatchObject({
      code: "SEARCH_PROVIDER_ERROR",
    });
  });
});

function indexedPage(): PageReadArtifact {
  return {
    status: "ok",
    sourceUrl: "https://example.com/h3",
    finalUrl: "https://example.com/h3",
    fetchedAt: new Date().toISOString(),
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "MiniMax H3",
    byline: null,
    publishedTime: null,
    contentMarkdown: "MiniMax H3 inference optimization guide.",
    contentHash: "hash",
    completeness: "complete",
    validation: { outcome: "valid", validatorVersion: "generic-content-v1", checks: [], terminalError: null },
    discoveredLinks: [],
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 100,
      contentCharacters: 40,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId: "request-test",
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{
          stageId: "http-read",
          provider: "http",
          reasonCode: "HTTP_PRIMARY",
        }],
        executedStages: ["http-read"],
      },
    },
  };
}

function webResult(): SearchWebResult {
  return {
    status: "ok",
    query: "MiniMax H3",
    provider: "test-web",
    searchedAt: new Date().toISOString(),
    page: 1,
    results: [
      {
        title: "Duplicate",
        url: "https://example.com/h3#details",
        snippet: "duplicate",
        source: "web",
        engines: ["test"],
        score: 1,
        publishedAt: null,
        thumbnailUrl: null,
      },
      {
        title: "Other",
        url: "https://example.com/other",
        snippet: "other",
        source: "web",
        engines: ["test"],
        score: 0.5,
        publishedAt: null,
        thumbnailUrl: null,
      },
    ],
    totalResults: 2,
    warnings: [],
  };
}
