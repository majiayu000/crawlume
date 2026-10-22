import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

const failures = vi.hoisted(() => ({ metadataWrite: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (failures.metadataWrite && typeof args[0] === "number") throw new Error("disk full");
    return actual.writeFileSync(...args);
  } };
});

import { main, parseCli } from "../src/cli/main.js";

const directories: string[] = [];

afterEach(() => {
  failures.metadataWrite = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

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
    [["backup"], "exactly one backup path"],
    [["restore", "only-backup.sqlite"], "backup path and a new target path"],
  ])("rejects invalid arguments", (argv, message) => {
    expect(() => parseCli(argv)).toThrow(message);
  });

  it("supports help without initializing the reader", () => {
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["read", "--help"])).toEqual({ kind: "help" });
  });

  it("parses backup and restore paths as absolute paths", () => {
    expect(parseCli(["backup", "out/cache.sqlite"]))
      .toEqual({ kind: "backup", backupPath: resolve("out/cache.sqlite") });
    expect(parseCli(["restore", "out/cache.sqlite", "restored.sqlite"])).toEqual({
      kind: "restore",
      backupPath: resolve("out/cache.sqlite"),
      targetPath: resolve("restored.sqlite"),
    });
  });

  it("leaves no orphan database or partial sidecar after metadata failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "crawlume-cli-backup-fail-"));
    directories.push(directory);
    vi.stubEnv("CRAWLUME_DATA_DIR", directory);
    const source = new DatabaseSync(join(directory, "cache.sqlite"));
    source.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY) STRICT;");
    source.close();
    const backupPath = join(directory, "backup.sqlite");
    failures.metadataWrite = true;
    expect(await main(["backup", backupPath])).toBe(1);
    expect(existsSync(backupPath)).toBe(false);
    expect(existsSync(`${backupPath}.json`)).toBe(false);
    failures.metadataWrite = false;
    writeFileSync(`${backupPath}.json`, "old metadata");
    expect(await main(["backup", backupPath])).toBe(1);
    expect(existsSync(backupPath)).toBe(false);
    expect(readFileSync(`${backupPath}.json`, "utf8")).toBe("old metadata");
  });

  it("backs up the runtime database with metadata and restores it to a new path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "crawlume-cli-backup-"));
    directories.push(directory);
    const dataDir = join(directory, "data");
    vi.stubEnv("CRAWLUME_DATA_DIR", dataDir);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["stats"])).toBe(0);

    const backupPath = join(directory, "backup", "cache.sqlite");
    expect(await main(["backup", backupPath])).toBe(0);
    expect(existsSync(`${backupPath}.json`)).toBe(true);
    expect(await main(["backup", backupPath])).toBe(1);

    const targetPath = join(directory, "restored", "cache.sqlite");
    expect(await main(["restore", backupPath, targetPath])).toBe(0);
    const restored = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      restored.close();
    }
    expect(await main(["restore", backupPath, targetPath])).toBe(1);
    expect(await main(["restore", join(directory, "missing.sqlite"), join(directory, "other.sqlite")]))
      .toBe(1);
    expect(errors).toHaveBeenCalled();
  });
});
