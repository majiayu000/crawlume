import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { AttemptLedger } from "../src/jobs.js";
import { ReaderService } from "../src/reader.js";
import { RslAccessAudit } from "../src/rsl-audit.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import type { PageFetcher } from "../src/types.js";
import { publicResolver, rawPage, testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("Reader RSL audit commit ordering", () => {
  it("leaves no successful cache or terminal when the success audit fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diaoyan-reader-audit-order-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "cache.sqlite");
    const config = { ...testConfig(), cachePath: databasePath };
    const audit = new RslAccessAudit(databasePath, "ai-input");
    audit.close();
    const ledger = new AttemptLedger(databasePath);
    const fetcher: PageFetcher = { async fetch() { return rawPage(); } };
    const reader = new ReaderService(
      config,
      new UrlPolicy(async () => publicResolver()),
      new PageCache(databasePath),
      fetcher,
      fetcher,
      null,
      null,
      null,
      audit,
      () => "",
      ledger,
    );

    await expect(reader.readPage({
      url: "https://example.com/article",
      browserAllowed: false,
      cacheMode: "live",
      requestId: "audit-failure-request",
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await reader.close();
    ledger.close();

    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM artifact_cache_entries").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_request_terminals").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
