import { randomUUID } from "node:crypto";

import { ReadError } from "./errors.js";
import { LocalPageIndex } from "./index.js";
import {
  searchSources,
  searchTimeRanges,
  type SearchResult,
  type SearchServingResult,
  type SearchServingStatus,
  type SearchWebOptions,
  type SearchWebResult,
} from "./types.js";

const maximumQueryCharacters = 512;
export const maximumSearchResults = 20;

export type ProviderSearchOptions = Required<Omit<SearchWebOptions, "timeRange" | "source">> & {
  timeRange?: SearchWebOptions["timeRange"];
};

export interface SearchProvider {
  readonly name: string;
  search(options: ProviderSearchOptions): Promise<SearchWebResult>;
}

type SearchExecution = {
  result: SearchWebResult;
  sources: Array<"local" | "web">;
};

export class SearchService {
  constructor(
    private readonly provider: SearchProvider | null,
    private readonly localIndex: LocalPageIndex | null = null,
  ) {}

  status(): SearchServingStatus {
    return {
      status: this.provider === null && this.localIndex === null ? "unavailable" : "ready",
      localIndexAvailable: this.localIndex !== null,
      localDocuments: this.localIndex?.count() ?? null,
      webProvider: this.provider?.name ?? null,
      retrievalVersion: this.localIndex === null ? null : "local-fts5-v1",
    };
  }

  async searchWeb(options: SearchWebOptions): Promise<SearchServingResult> {
    const normalized = normalizeOptions(options);
    const source = options.source ?? "auto";
    const usesLocal = source === "local" || (source === "auto" && normalized.page === 1);
    const localSnapshot = usesLocal && this.localIndex !== null
      ? { retrievalVersion: "local-fts5-v1" as const, documents: this.localIndex.count() }
      : null;
    const execution = source === "web" || (source === "auto" && normalized.page > 1)
      ? { result: await this.searchProvider(normalized), sources: ["web" as const] }
      : source === "local"
        ? { result: this.searchLocal(normalized), sources: ["local" as const] }
        : await this.searchAuto(normalized);
    return {
      ...execution.result,
      trace: {
        correlationId: randomUUID(),
        requestedSource: source,
        executedSources: execution.sources,
        localSnapshot,
      },
    };
  }

  private searchLocal(options: ProviderSearchOptions): SearchWebResult {
    if (this.localIndex === null) {
      throw new ReadError("SEARCH_PROVIDER_NOT_CONFIGURED", "The local page index is not available.");
    }
    return localResult(
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

  private async searchAuto(options: ProviderSearchOptions): Promise<SearchExecution> {
    const localResults = this.localIndex?.search(
      options.query,
      options.limit,
      1,
      options.timeRange,
    ) ?? [];
    if (localResults.length >= options.limit) {
      return { result: localResult(options, localResults), sources: ["local"] };
    }
    if (this.provider === null) {
      if ((this.localIndex?.count() ?? 0) > 0) {
        return { result: localResult(options, localResults), sources: ["local"] };
      }
      throw new ReadError(
        "SEARCH_PROVIDER_NOT_CONFIGURED",
        "No indexed pages or web search provider are available. Read or crawl pages first, or set DIAOYAN_SEARXNG_URL.",
      );
    }

    const sources: Array<"local" | "web"> = this.localIndex === null
      ? ["web"]
      : ["local", "web"];
    try {
      const web = await this.provider.search(options);
      if (localResults.length === 0) {
        return { result: web, sources };
      }
      return {
        result: {
          status: "ok",
          query: options.query,
          provider: `local+${this.provider.name}`,
          searchedAt: new Date().toISOString(),
          page: 1,
          results: mergeResults(localResults, web.results, options.limit),
          totalResults: null,
          warnings: [],
        },
        sources,
      };
    } catch (error) {
      if (localResults.length === 0) throw error;
      const normalized = error instanceof ReadError
        ? error
        : new ReadError("SEARCH_PROVIDER_ERROR", "The web search provider failed.", {
            retryable: true,
            cause: error,
          });
      return {
        result: {
          ...localResult(options, localResults),
          status: "partial",
          provider: `local+${this.provider.name}`,
          warnings: [{
            code: normalized.code,
            message: normalized.message,
            retryable: normalized.retryable,
          }],
        },
        sources,
      };
    }
  }
}

function normalizeOptions(options: SearchWebOptions): ProviderSearchOptions {
  const query = options.query.replace(/\s+/g, " ").trim();
  if (query.length === 0 || query.length > maximumQueryCharacters) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      `query must contain between 1 and ${maximumQueryCharacters} characters.`,
      { details: { queryCharacters: query.length, maximumQueryCharacters } },
    );
  }
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximumSearchResults) {
    throw new ReadError("INVALID_ARGUMENT", `limit must be an integer between 1 and ${maximumSearchResults}.`, {
      details: { limit, maximumResults: maximumSearchResults },
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
  if (options.timeRange !== undefined && !searchTimeRanges.includes(options.timeRange)) {
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
  return {
    query,
    limit,
    page,
    language,
    safeSearch,
    ...(options.timeRange === undefined ? {} : { timeRange: options.timeRange }),
  };
}

function localResult(options: ProviderSearchOptions, results: SearchResult[]): SearchWebResult {
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

function mergeResults(local: SearchResult[], web: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const result of [...local, ...web]) {
    const url = new URL(result.url);
    url.hash = "";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(result);
    if (merged.length >= limit) break;
  }
  return merged;
}
