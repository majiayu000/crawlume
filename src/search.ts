import { JSDOM } from "jsdom";
import { fetch } from "undici";
import { z } from "zod";

import { ReadError } from "./errors.js";
import { LocalPageIndex } from "./index.js";
import {
  searchSources,
  searchTimeRanges,
  type SearchResult,
  type SearchWebOptions,
  type SearchWebResult,
} from "./types.js";

const maximumQueryCharacters = 512;
const maximumResults = 20;
const maximumResponseBytes = 2_000_000;

type SearchResponse = {
  status: number;
  contentType: string;
  body: string;
  responseBytes: number;
};

export type SearchRequester = (url: URL) => Promise<SearchResponse>;

type ProviderSearchOptions = Required<Omit<SearchWebOptions, "timeRange" | "source">> & {
  timeRange?: SearchWebOptions["timeRange"];
};

export interface SearchProvider {
  readonly name: string;
  search(options: ProviderSearchOptions): Promise<SearchWebResult>;
}

const searxngResponse = z.object({
  number_of_results: z.number().optional(),
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      content: z.string().nullish(),
      engine: z.string().nullish(),
      engines: z.array(z.string()).nullish(),
      score: z.number().nullish(),
      publishedDate: z.string().nullish(),
      thumbnail: z.string().nullish(),
    }).passthrough(),
  ),
}).passthrough();

function htmlToText(value: string): string {
  return (JSDOM.fragment(value).textContent ?? "").replace(/\s+/g, " ").trim();
}

async function readBoundedResponse(
  response: Awaited<ReturnType<typeof fetch>>,
): Promise<{ body: string; bytes: number }> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    await response.body?.cancel();
    throw new ReadError("SEARCH_PROVIDER_ERROR", "The search response is too large.", {
      details: { contentLength: declaredLength, maximumResponseBytes },
    });
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { body: "", bytes: 0 };
  }
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        body += decoder.decode();
        return { body, bytes };
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumResponseBytes) {
        await reader.cancel("search response too large");
        throw new ReadError("SEARCH_PROVIDER_ERROR", "The search response is too large.", {
          details: { maximumResponseBytes },
        });
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function defaultRequester(userAgent: string, timeoutMs: number): SearchRequester {
  return async (url): Promise<SearchResponse> => {
    let response;
    try {
      response = await fetch(url, {
        redirect: "error",
        headers: {
          accept: "application/json",
          "accept-language": "en-US,en;q=0.8",
          "user-agent": userAgent,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ReadError(
        "SEARCH_PROVIDER_ERROR",
        isTimeout ? "The search provider timed out." : "The search provider request failed.",
        { retryable: true, details: { providerUrl: url.origin }, cause: error },
      );
    }
    const decoded = await readBoundedResponse(response);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: decoded.body,
      responseBytes: decoded.bytes,
    };
  };
}

export class SearxngProvider implements SearchProvider {
  readonly name = "searxng";
  private readonly baseUrl: URL;
  private readonly requester: SearchRequester;

  constructor(
    baseUrl: string,
    userAgent: string,
    timeoutMs: number,
    requester: SearchRequester = defaultRequester(userAgent, timeoutMs),
  ) {
    if (!URL.canParse(baseUrl)) {
      throw new ReadError("INVALID_ARGUMENT", "DIAOYAN_SEARXNG_URL is not a valid URL.");
    }
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new ReadError("INVALID_ARGUMENT", "DIAOYAN_SEARXNG_URL must use http or https.");
    }
    if (this.baseUrl.username !== "" || this.baseUrl.password !== "") {
      throw new ReadError("INVALID_ARGUMENT", "Credentials in DIAOYAN_SEARXNG_URL are not allowed.");
    }
    this.requester = requester;
  }

  async search(options: ProviderSearchOptions): Promise<SearchWebResult> {
    const base = new URL(this.baseUrl);
    if (!base.pathname.endsWith("/")) {
      base.pathname += "/";
    }
    const endpoint = new URL("search", base);
    endpoint.searchParams.set("q", options.query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("categories", "general");
    endpoint.searchParams.set("language", options.language);
    endpoint.searchParams.set("pageno", String(options.page));
    endpoint.searchParams.set("safesearch", String(options.safeSearch));
    if (options.timeRange !== undefined) {
      endpoint.searchParams.set("time_range", options.timeRange);
    }

    const response = await this.requester(endpoint);
    if (response.status < 200 || response.status >= 300) {
      throw new ReadError(
        "SEARCH_PROVIDER_ERROR",
        response.status === 403
          ? "SearXNG rejected JSON search; enable the json format in settings.yml."
          : `SearXNG returned HTTP ${response.status}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
          details: { httpStatus: response.status, provider: this.name },
        },
      );
    }
    if (!response.contentType.toLowerCase().includes("json")) {
      throw new ReadError("SEARCH_PROVIDER_ERROR", "SearXNG returned a non-JSON response.", {
        details: { contentType: response.contentType, provider: this.name },
      });
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(response.body);
    } catch (error) {
      throw new ReadError("SEARCH_PROVIDER_ERROR", "SearXNG returned malformed JSON.", {
        details: { provider: this.name, responseBytes: response.responseBytes },
        cause: error,
      });
    }
    const parsed = searxngResponse.safeParse(decoded);
    if (!parsed.success) {
      throw new ReadError("SEARCH_PROVIDER_ERROR", "SearXNG returned an unsupported response shape.", {
        details: { provider: this.name, responseBytes: response.responseBytes },
        cause: parsed.error,
      });
    }

    const seen = new Set<string>();
    const results = [];
    for (const item of parsed.data.results) {
      if (!URL.canParse(item.url)) {
        throw new ReadError("SEARCH_PROVIDER_ERROR", "SearXNG returned an invalid result URL.", {
          details: { provider: this.name },
        });
      }
      const url = new URL(item.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ReadError("SEARCH_PROVIDER_ERROR", "SearXNG returned an unsupported result URL.", {
          details: { protocol: url.protocol, provider: this.name },
        });
      }
      url.hash = "";
      const normalizedUrl = url.toString();
      if (seen.has(normalizedUrl)) {
        continue;
      }
      seen.add(normalizedUrl);
      const engines = item.engines ?? (item.engine === null || item.engine === undefined ? [] : [item.engine]);
      results.push({
        title: htmlToText(item.title),
        url: normalizedUrl,
        snippet: htmlToText(item.content ?? ""),
        source: "web" as const,
        engines,
        score: item.score ?? null,
        publishedAt: item.publishedDate ?? null,
        thumbnailUrl: item.thumbnail ?? null,
      });
      if (results.length >= options.limit) {
        break;
      }
    }

    return {
      status: "ok",
      query: options.query,
      provider: this.name,
      searchedAt: new Date().toISOString(),
      page: options.page,
      results,
      totalResults: parsed.data.number_of_results ?? null,
      warnings: [],
    };
  }
}

export class SearchService {
  constructor(
    private readonly provider: SearchProvider | null,
    private readonly localIndex: LocalPageIndex | null = null,
  ) {}

  async searchWeb(options: SearchWebOptions): Promise<SearchWebResult> {
    const query = options.query.replace(/\s+/g, " ").trim();
    if (query.length === 0 || query.length > maximumQueryCharacters) {
      throw new ReadError(
        "INVALID_ARGUMENT",
        `query must contain between 1 and ${maximumQueryCharacters} characters.`,
        { details: { queryCharacters: query.length, maximumQueryCharacters } },
      );
    }
    const limit = options.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximumResults) {
      throw new ReadError("INVALID_ARGUMENT", `limit must be an integer between 1 and ${maximumResults}.`, {
        details: { limit, maximumResults },
      });
    }
    const page = options.page ?? 1;
    if (!Number.isSafeInteger(page) || page <= 0 || page > 100) {
      throw new ReadError("INVALID_ARGUMENT", "page must be an integer between 1 and 100.", {
        details: { page },
      });
    }
    const language = options.language ?? "all";
    if (!/^(?:all|[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)$/.test(language)) {
      throw new ReadError("INVALID_ARGUMENT", "language is not a supported language code.", {
        details: { language },
      });
    }
    const safeSearch = options.safeSearch ?? 1;
    if (safeSearch !== 0 && safeSearch !== 1 && safeSearch !== 2) {
      throw new ReadError("INVALID_ARGUMENT", "safeSearch must be 0, 1, or 2.", {
        details: { safeSearch },
      });
    }
    if (
      options.timeRange !== undefined &&
      !searchTimeRanges.includes(options.timeRange)
    ) {
      throw new ReadError("INVALID_ARGUMENT", "timeRange must be day, month, or year.", {
        details: { timeRange: options.timeRange },
      });
    }

    const source = options.source ?? "auto";
    if (!searchSources.includes(source)) {
      throw new ReadError("INVALID_ARGUMENT", "source must be auto, local, or web.", {
        details: { source },
      });
    }

    const normalized: ProviderSearchOptions = {
      query,
      limit,
      page,
      language,
      safeSearch,
      ...(options.timeRange === undefined ? {} : { timeRange: options.timeRange }),
    };

    if (source === "web" || (source === "auto" && page > 1)) {
      return this.searchProvider(normalized);
    }
    if (source === "local") {
      return this.searchLocal(normalized);
    }
    return this.searchAuto(normalized);
  }

  private searchLocal(options: ProviderSearchOptions): SearchWebResult {
    if (this.localIndex === null) {
      throw new ReadError(
        "SEARCH_PROVIDER_NOT_CONFIGURED",
        "The local page index is not available.",
      );
    }
    return this.localResult(
      options,
      this.localIndex.search(options.query, options.limit, options.page, options.timeRange),
    );
  }

  private async searchProvider(options: ProviderSearchOptions): Promise<SearchWebResult> {
    if (this.provider === null) {
      throw new ReadError(
        "SEARCH_PROVIDER_NOT_CONFIGURED",
        "No web search provider is configured. Set DIAOYAN_SEARXNG_URL or use source=local.",
      );
    }
    return this.provider.search(options);
  }

  private async searchAuto(options: ProviderSearchOptions): Promise<SearchWebResult> {
    const localResults = this.localIndex?.search(
      options.query,
      options.limit,
      1,
      options.timeRange,
    ) ?? [];
    if (localResults.length >= options.limit) {
      return this.localResult(options, localResults);
    }
    if (this.provider === null) {
      if ((this.localIndex?.count() ?? 0) > 0) {
        return this.localResult(options, localResults);
      }
      throw new ReadError(
        "SEARCH_PROVIDER_NOT_CONFIGURED",
        "No indexed pages or web search provider are available. Read or crawl pages first, or set DIAOYAN_SEARXNG_URL.",
      );
    }

    try {
      const web = await this.provider.search(options);
      if (localResults.length === 0) {
        return web;
      }
      return {
        status: "ok",
        query: options.query,
        provider: `local+${this.provider.name}`,
        searchedAt: new Date().toISOString(),
        page: 1,
        results: mergeResults(localResults, web.results, options.limit),
        totalResults: null,
        warnings: [],
      };
    } catch (error) {
      if (localResults.length === 0) {
        throw error;
      }
      const normalized = error instanceof ReadError
        ? error
        : new ReadError("SEARCH_PROVIDER_ERROR", "The web search provider failed.", {
            retryable: true,
            cause: error,
          });
      return {
        ...this.localResult(options, localResults),
        status: "partial",
        provider: `local+${this.provider.name}`,
        warnings: [{
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
        }],
      };
    }
  }

  private localResult(options: ProviderSearchOptions, results: SearchResult[]): SearchWebResult {
    return {
      status: "ok",
      query: options.query,
      provider: "local",
      searchedAt: new Date().toISOString(),
      page: options.page,
      results,
      totalResults: null,
      warnings: [],
    };
  }
}

function mergeResults(local: SearchResult[], web: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const result of [...local, ...web]) {
    const url = new URL(result.url);
    url.hash = "";
    const key = url.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(result);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
}
