import { describe, expect, it, vi } from "vitest";

import { SearchService, SearxngProvider } from "../src/search.js";
import type { SearchRequester } from "../src/search.js";

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
        engines: ["bing", "google"],
        score: 3.5,
        publishedAt: "2026-07-31T00:00:00Z",
        thumbnailUrl: "https://example.com/h3.png",
      },
      {
        title: "Guide",
        url: "https://example.com/guide",
        snippet: "",
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
