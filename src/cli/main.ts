#!/usr/bin/env node

import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createApp, type DiaoyanApp } from "../app.js";
import { loadConfig } from "../config.js";
import { normalizeError, ReadError } from "../errors.js";
import {
  cacheModes,
  type CacheMode,
  type ReadPageOptions,
  type SearchSource,
  type SearchTimeRange,
  type SearchWebOptions,
  searchSources,
  searchTimeRanges,
} from "../types.js";

const usage = `Usage:
  diaoyan read <url> [options]
  diaoyan map <url> [options]
  diaoyan crawl <url> [options]
  diaoyan search <query> [options]
  diaoyan stats [--days <1-90>]
  diaoyan rsl-audit [--limit <1-1000>]

Options:
  --no-browser                               Forbid browser execution
  --cache-mode <prefer-cache|live|cache-only> Cache strategy (default: prefer-cache)
  --max-age-seconds <seconds>                Maximum cache age (default: 900)
  --auth-profile <name>                      Dedicated browser profile
  --max-pages <count>                        Site page limit (map: 50, crawl: 10)
  --max-depth <depth>                        Link depth limit (default: 2)
  --include-subdomains                       Include child subdomains
  --keep-query                               Keep query parameters when deduplicating
  --markdown                                 Print only Markdown (read only)
  --limit <count>                            Search results (max: 20) or RSL audit records (max: 1000)
  --page <number>                            Search result page (default: 1)
  --language <code>                          Search language (default: all)
  --safe-search <0|1|2>                      Search filtering level (default: 1)
  --time-range <day|month|year>              Optional search time range
  --source <auto|local|web>                  Search local index, web, or both (default: auto)
  --days <count>                             Statistics window in UTC days (default: 7, max: 90)
  -h, --help                                 Show this help
`;

export type CliAction =
  | { kind: "help" }
  | { kind: "read"; options: ReadPageOptions; markdown: boolean }
  | { kind: "map"; options: import("../types.js").MapSiteOptions }
  | { kind: "crawl"; options: import("../types.js").CrawlSiteOptions }
  | { kind: "search"; options: SearchWebOptions }
  | { kind: "stats"; days: number }
  | { kind: "rsl-audit"; limit: number };

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ReadError("INVALID_ARGUMENT", `${flag} requires a value.`, {
      details: { flag },
    });
  }
  return value;
}

function parseChoice<T extends string>(value: string, choices: readonly T[], flag: string): T {
  if (!choices.includes(value as T)) {
    throw new ReadError("INVALID_ARGUMENT", `${flag} has an unsupported value.`, {
      details: { flag, value, allowed: choices.join(",") },
    });
  }
  return value as T;
}

function parseSearchCli(argv: string[]): CliAction {
  const queryParts: string[] = [];
  let limit = 10;
  let page = 1;
  let language = "all";
  let safeSearch: 0 | 1 | 2 = 1;
  let timeRange: SearchTimeRange | undefined;
  let source: SearchSource = "auto";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { kind: "help" };
    }
    if (argument === "--limit") {
      const value = nextValue(argv, index, argument);
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 20) {
        throw new ReadError("INVALID_ARGUMENT", "--limit must be an integer between 1 and 20.", {
          details: { value },
        });
      }
      index += 1;
      continue;
    }
    if (argument === "--page") {
      const value = nextValue(argv, index, argument);
      page = Number(value);
      if (!Number.isSafeInteger(page) || page <= 0 || page > 100) {
        throw new ReadError("INVALID_ARGUMENT", "--page must be an integer between 1 and 100.", {
          details: { value },
        });
      }
      index += 1;
      continue;
    }
    if (argument === "--language") {
      language = nextValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--safe-search") {
      const value = nextValue(argv, index, argument);
      const parsed = Number(value);
      if (parsed !== 0 && parsed !== 1 && parsed !== 2) {
        throw new ReadError("INVALID_ARGUMENT", "--safe-search must be 0, 1, or 2.", {
          details: { value },
        });
      }
      safeSearch = parsed;
      index += 1;
      continue;
    }
    if (argument === "--time-range") {
      const value = nextValue(argv, index, argument);
      timeRange = parseChoice(value, searchTimeRanges, argument);
      index += 1;
      continue;
    }
    if (argument === "--source") {
      source = parseChoice(nextValue(argv, index, argument), searchSources, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) {
      throw new ReadError("INVALID_ARGUMENT", "Unknown search option.", {
        details: { option: argument },
      });
    }
    if (argument !== undefined) {
      queryParts.push(argument);
    }
  }

  const query = queryParts.join(" ").trim();
  if (query === "") {
    throw new ReadError("INVALID_ARGUMENT", "search requires a query.");
  }
  return {
    kind: "search",
    options: {
      query,
      limit,
      page,
      language,
      safeSearch,
      source,
      ...(timeRange === undefined ? {} : { timeRange }),
    },
  };
}

function parseStatsCli(argv: string[]): CliAction {
  let days = 7;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { kind: "help" };
    }
    if (argument === "--days") {
      const value = nextValue(argv, index, argument);
      days = Number(value);
      if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
        throw new ReadError("INVALID_ARGUMENT", "--days must be an integer between 1 and 90.", {
          details: { value },
        });
      }
      index += 1;
      continue;
    }
    throw new ReadError("INVALID_ARGUMENT", "Unknown stats option.", {
      details: { option: argument ?? null },
    });
  }
  return { kind: "stats", days };
}

function parseRslAuditCli(argv: string[]): CliAction {
  let limit = 100;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument === "--limit") {
      const value = nextValue(argv, index, argument);
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new ReadError("INVALID_ARGUMENT", "--limit must be an integer between 1 and 1000.", {
          details: { value },
        });
      }
      index += 1;
      continue;
    }
    throw new ReadError("INVALID_ARGUMENT", "Unknown rsl-audit option.", {
      details: { option: argument ?? null },
    });
  }
  return { kind: "rsl-audit", limit };
}

export function parseCli(argv: string[]): CliAction {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help" };
  }
  const command = argv[0];
  if (
    command !== "read" &&
    command !== "map" &&
    command !== "crawl" &&
    command !== "search" &&
    command !== "stats" &&
    command !== "rsl-audit"
  ) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      "Supported commands are read, map, crawl, search, stats, and rsl-audit.",
      { details: { command: argv[0] ?? null } },
    );
  }
  if (command === "search") {
    return parseSearchCli(argv.slice(1));
  }
  if (command === "stats") {
    return parseStatsCli(argv.slice(1));
  }
  if (command === "rsl-audit") {
    return parseRslAuditCli(argv.slice(1));
  }

  let url: string | null = null;
  let browserAllowed = true;
  let cacheMode: CacheMode = "prefer-cache";
  let maxAgeSeconds = 900;
  let authProfile: string | undefined;
  let markdown = false;
  let maxPages = command === "map" ? 50 : 10;
  let maxDepth = 2;
  let includeSubdomains = false;
  let ignoreQueryParameters = true;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { kind: "help" };
    }
    if (argument === "--markdown") {
      if (command !== "read") {
        throw new ReadError("INVALID_ARGUMENT", "--markdown is available only for read.");
      }
      markdown = true;
      continue;
    }
    if (argument === "--no-browser") {
      browserAllowed = false;
      continue;
    }
    if (argument === "--cache-mode") {
      if (command === "map") {
        throw new ReadError("INVALID_ARGUMENT", "--cache-mode is not available for map.");
      }
      const value = nextValue(argv, index, argument);
      cacheMode = parseChoice(value, cacheModes, argument);
      index += 1;
      continue;
    }
    if (argument === "--max-age-seconds") {
      if (command === "map") {
        throw new ReadError("INVALID_ARGUMENT", "--max-age-seconds is not available for map.");
      }
      const value = nextValue(argv, index, argument);
      maxAgeSeconds = Number(value);
      if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
        throw new ReadError(
          "INVALID_ARGUMENT",
          "--max-age-seconds must be a positive integer.",
          { details: { value } },
        );
      }
      index += 1;
      continue;
    }
    if (argument === "--auth-profile") {
      authProfile = nextValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--max-pages") {
      if (command === "read") {
        throw new ReadError("INVALID_ARGUMENT", "--max-pages is available only for map or crawl.");
      }
      const value = nextValue(argv, index, argument);
      maxPages = Number(value);
      const maximum = command === "map" ? 500 : 50;
      if (!Number.isSafeInteger(maxPages) || maxPages <= 0 || maxPages > maximum) {
        throw new ReadError(
          "INVALID_ARGUMENT",
          `--max-pages must be an integer between 1 and ${maximum}.`,
          { details: { value, maximum } },
        );
      }
      index += 1;
      continue;
    }
    if (argument === "--max-depth") {
      if (command === "read") {
        throw new ReadError("INVALID_ARGUMENT", "--max-depth is available only for map or crawl.");
      }
      const value = nextValue(argv, index, argument);
      maxDepth = Number(value);
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) {
        throw new ReadError("INVALID_ARGUMENT", "--max-depth must be an integer between 0 and 10.", {
          details: { value },
        });
      }
      index += 1;
      continue;
    }
    if (argument === "--include-subdomains") {
      if (command === "read") {
        throw new ReadError(
          "INVALID_ARGUMENT",
          "--include-subdomains is available only for map or crawl.",
        );
      }
      includeSubdomains = true;
      continue;
    }
    if (argument === "--keep-query") {
      if (command === "read") {
        throw new ReadError("INVALID_ARGUMENT", "--keep-query is available only for map or crawl.");
      }
      ignoreQueryParameters = false;
      continue;
    }
    if (argument?.startsWith("-")) {
      throw new ReadError("INVALID_ARGUMENT", "Unknown command-line option.", {
        details: { option: argument },
      });
    }
    if (url !== null) {
      throw new ReadError("INVALID_ARGUMENT", `${command} accepts exactly one URL.`);
    }
    url = argument ?? null;
  }

  if (url === null) {
    throw new ReadError("INVALID_ARGUMENT", `${command} requires a URL.`);
  }
  if (authProfile !== undefined && !browserAllowed) {
    throw new ReadError("INVALID_ARGUMENT", "--auth-profile requires browser access.");
  }

  const common = { url, browserAllowed };
  if (command === "map") {
    return {
      kind: "map",
      options: {
        ...common,
        maxPages,
        maxDepth,
        includeSubdomains,
        ignoreQueryParameters,
        ...(authProfile === undefined ? {} : { authProfile }),
      },
    };
  }

  const options: ReadPageOptions = { ...common, cacheMode, maxAgeSeconds };
  if (authProfile !== undefined) {
    options.authProfile = authProfile;
  }
  if (command === "crawl") {
    return {
      kind: "crawl",
      options: {
        ...options,
        maxPages,
        maxDepth,
        includeSubdomains,
        ignoreQueryParameters,
      },
    };
  }
  return { kind: "read", options, markdown };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let app: DiaoyanApp | null = null;
  try {
    const action = parseCli(argv);
    if (action.kind === "help") {
      process.stdout.write(usage);
      return 0;
    }
    app = createApp(loadConfig(), { runCrawlWorker: false });
    if (action.kind === "read") {
      const result = await app.reader.readPage(action.options);
      process.stdout.write(
        action.markdown
          ? `${result.contentMarkdown}\n`
          : `${JSON.stringify(result, null, 2)}\n`,
      );
    } else if (action.kind === "map") {
      process.stdout.write(`${JSON.stringify(await app.site.mapSite(action.options), null, 2)}\n`);
    } else if (action.kind === "crawl") {
      process.stdout.write(`${JSON.stringify(await app.site.crawlSite(action.options), null, 2)}\n`);
    } else if (action.kind === "search") {
      process.stdout.write(`${JSON.stringify(await app.search.searchWeb(action.options), null, 2)}\n`);
    } else if (action.kind === "stats") {
      process.stdout.write(`${JSON.stringify(app.metrics.getStats(action.days), null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(app.rslAudit.list(action.limit), null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(normalizeError(error).toJSON(), null, 2)}\n`);
    return 1;
  } finally {
    await app?.close();
  }
}

const entry = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entry !== "" && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
