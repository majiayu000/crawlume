#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createApp, type CrawlumeApp } from "../app.js";
import { loadConfig } from "../config.js";
import { normalizeError, ReadError } from "../errors.js";
import { packageManifest } from "../package-manifest.js";
import { buildReadReport, type ReportOutcome } from "./report.js";
import {
  createSqliteBackup,
  restoreSqliteBackup,
  type SqliteBackupMetadata,
} from "../sqlite-backup.js";
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
  crawlume read <url> [options]
  crawlume report <url> [options]
  crawlume extract <url> [options]
  crawlume map <url> [options]
  crawlume crawl <url> [options]
  crawlume search <query> [options]
  crawlume stats [--days <1-90>]
  crawlume rsl-audit [--limit <1-1000>]
  crawlume backup <backup-path>
  crawlume restore <backup-path> <target-path>

Options:
  --no-browser                               Forbid browser execution
  --cache-mode <prefer-cache|live|cache-only> Cache strategy (default: prefer-cache)
  --max-age-seconds <seconds>                Maximum cache age (default: 900)
  --stale-while-revalidate-seconds <seconds> Serve bounded stale content while refreshing
  --auth-profile <name>                      Dedicated browser profile
  --schema-id <id>                           Optional extract output schema (extract only)
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
  | { kind: "report"; options: ReadPageOptions }
  | { kind: "extract"; options: ReadPageOptions }
  | { kind: "map"; options: import("../types.js").MapSiteOptions }
  | { kind: "crawl"; options: import("../types.js").CrawlSiteOptions }
  | { kind: "search"; options: SearchWebOptions }
  | { kind: "stats"; days: number }
  | { kind: "rsl-audit"; limit: number }
  | { kind: "backup"; backupPath: string }
  | { kind: "restore"; backupPath: string; targetPath: string };

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

function parseBackupCli(command: "backup" | "restore", argv: string[]): CliAction {
  if (argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  const expected = command === "backup" ? 1 : 2;
  if (argv.length !== expected || argv.some((value) => value.startsWith("-"))) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      command === "backup"
        ? "backup requires exactly one backup path."
        : "restore requires a backup path and a new target path.",
      { details: { arguments: argv.join(" ") } },
    );
  }
  return command === "backup"
    ? { kind: "backup", backupPath: resolve(argv[0] as string) }
    : { kind: "restore", backupPath: resolve(argv[0] as string), targetPath: resolve(argv[1] as string) };
}

function backupMetadataPath(backupPath: string): string {
  return `${backupPath}.json`;
}

export function parseCli(argv: string[]): CliAction {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help" };
  }
  const command = argv[0];
  if (
    command !== "read" &&
    command !== "report" &&
    command !== "extract" &&
    command !== "map" &&
    command !== "crawl" &&
    command !== "search" &&
    command !== "stats" &&
    command !== "rsl-audit" &&
    command !== "backup" &&
    command !== "restore"
  ) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      "Supported commands are read, report, extract, map, crawl, search, stats, rsl-audit, backup, and restore.",
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
  if (command === "backup" || command === "restore") {
    return parseBackupCli(command, argv.slice(1));
  }

  let url: string | null = null;
  let browserAllowed: boolean | undefined;
  let cacheMode: CacheMode | undefined;
  let maxAgeSeconds: number | undefined;
  let staleWhileRevalidateSeconds: number | undefined;
  let authProfile: string | undefined;
  let schemaId: string | undefined;
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
    if (argument === "--stale-while-revalidate-seconds") {
      if (command === "map") {
        throw new ReadError(
          "INVALID_ARGUMENT",
          "--stale-while-revalidate-seconds is not available for map.",
        );
      }
      const value = nextValue(argv, index, argument);
      staleWhileRevalidateSeconds = Number(value);
      if (!Number.isSafeInteger(staleWhileRevalidateSeconds) || staleWhileRevalidateSeconds < 0) {
        throw new ReadError(
          "INVALID_ARGUMENT",
          "--stale-while-revalidate-seconds must be a non-negative integer.",
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
    if (argument === "--schema-id") {
      if (command !== "extract") {
        throw new ReadError("INVALID_ARGUMENT", "--schema-id is available only for extract.");
      }
      schemaId = nextValue(argv, index, argument);
      if (schemaId.trim().length === 0) {
        throw new ReadError("INVALID_ARGUMENT", "--schema-id must be non-empty.");
      }
      index += 1;
      continue;
    }
    if (argument === "--max-pages") {
      if (command === "read" || command === "report" || command === "extract") {
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
      if (command === "read" || command === "report" || command === "extract") {
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
      if (command === "read" || command === "report" || command === "extract") {
        throw new ReadError(
          "INVALID_ARGUMENT",
          "--include-subdomains is available only for map or crawl.",
        );
      }
      includeSubdomains = true;
      continue;
    }
    if (argument === "--keep-query") {
      if (command === "read" || command === "report" || command === "extract") {
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
  const common = {
    url,
    ...(browserAllowed === undefined ? {} : { browserAllowed }),
  };
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

  const options: ReadPageOptions = {
    ...common,
    ...(cacheMode === undefined ? {} : { cacheMode }),
    ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
    ...(staleWhileRevalidateSeconds === undefined
      ? {}
      : { staleWhileRevalidateSeconds }),
  };
  if (authProfile !== undefined) {
    options.authProfile = authProfile;
  }
  if (schemaId !== undefined) {
    options.schemaId = schemaId;
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
  if (command === "extract") {
    return { kind: "extract", options };
  }
  if (command === "report") {
    // A report reproduces the problem now, so it never answers from the cache.
    return { kind: "report", options: { ...options, cacheMode: "live" } };
  }
  return { kind: "read", options, markdown };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let app: CrawlumeApp | null = null;
  try {
    const action = parseCli(argv);
    if (action.kind === "help") {
      process.stdout.write(usage);
      return 0;
    }
    if (action.kind === "backup") {
      const metadataPath = backupMetadataPath(action.backupPath);
      mkdirSync(dirname(action.backupPath), { recursive: true, mode: 0o700 });
      if (existsSync(action.backupPath) || existsSync(metadataPath)) {
        throw new ReadError("INVALID_ARGUMENT", "Backup database or metadata target already exists.");
      }
      const staging = mkdtempSync(join(dirname(action.backupPath), ".crawlume-backup-"));
      const stagedBackup = join(staging, "backup.sqlite");
      const stagedMetadata = join(staging, "metadata.json");
      const published: string[] = [];
      let metadata: SqliteBackupMetadata;
      try {
        const probe = join(staging, "hardlink-probe");
        writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
        try {
          linkSync(probe, `${probe}.link`);
        } catch (error) {
          throw new ReadError("INVALID_ARGUMENT", "Backup destination must allow hard links.", {
            details: { path: dirname(action.backupPath) }, cause: error,
          });
        }
        metadata = await createSqliteBackup(loadConfig().cachePath, stagedBackup);
        writeFileSync(stagedMetadata, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        // No final output is visible during the asynchronous backup. Commit only complete files,
        // without yielding between publications; atomic links also refuse concurrent overwrites.
        linkSync(stagedBackup, action.backupPath);
        published.push(action.backupPath);
        linkSync(stagedMetadata, metadataPath);
        published.push(metadataPath);
      } catch (error) {
        const errors: unknown[] = [error];
        for (const path of published) {
          try { unlinkSync(path); } catch (cleanupError) { errors.push(cleanupError); }
        }
        if (errors.length > 1) throw new AggregateError(errors, "Backup and rollback both failed.");
        throw error;
      } finally {
        try {
          rmSync(staging, { recursive: true });
        } catch (error) {
          process.stderr.write(`Warning: backup staging cleanup failed; inspect leftover files at ${staging}: ${String(error)}\n`);
        }
      }
      process.stdout.write(`${JSON.stringify({ backupPath: action.backupPath, metadata }, null, 2)}\n`);
      return 0;
    }
    if (action.kind === "restore") {
      const metadataPath = backupMetadataPath(action.backupPath);
      let metadata: SqliteBackupMetadata;
      try {
        metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as SqliteBackupMetadata;
      } catch (error) {
        throw new ReadError("INVALID_ARGUMENT", "Backup metadata is missing or unreadable.", {
          details: { path: metadataPath },
          cause: error,
        });
      }
      await restoreSqliteBackup(action.backupPath, action.targetPath, metadata);
      process.stdout.write(`${JSON.stringify({ targetPath: action.targetPath, metadata }, null, 2)}\n`);
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
    } else if (action.kind === "report") {
      let outcome: ReportOutcome;
      try {
        outcome = { result: await app.reader.readPage(action.options) };
      } catch (error) {
        outcome = { error: normalizeError(error) };
      }
      const report = buildReadReport(action.options.url, outcome, packageManifest());
      process.stdout.write(
        `${report.body}\nReview the report above, then open this link to file it (nothing is sent until you submit):\n${report.issueUrl}\n`,
      );
    } else if (action.kind === "extract") {
      process.stdout.write(`${JSON.stringify(await app.reader.extractPage(action.options), null, 2)}\n`);
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
