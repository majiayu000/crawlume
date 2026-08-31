import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteBackup,
  restoreSqliteBackup,
  verifySqliteBackup,
} from "../src/sqlite-backup.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "diaoyan-sqlite-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("SQLite backup and recovery", () => {
  it("backs up committed data that is still in the source WAL", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const source = new DatabaseSync(sourcePath);
    databases.push(source);
    source.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE indexed_pages(id INTEGER PRIMARY KEY, final_url TEXT NOT NULL) STRICT;
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO indexed_pages(final_url) VALUES ('https://example.com/from-wal');
    `);
    expect(existsSync(`${sourcePath}-wal`)).toBe(true);
    expect(statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);

    const metadata = await createSqliteBackup(sourcePath, backupPath, {
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });

    const copy = new DatabaseSync(backupPath, { readOnly: true });
    databases.push(copy);
    expect(copy.prepare("SELECT final_url FROM indexed_pages").all()).toEqual([
      { final_url: "https://example.com/from-wal" },
    ]);
    expect(metadata).toMatchObject({
      format: "diaoyan-sqlite-backup-v1",
      createdAt: "2026-08-31T10:00:00.000Z",
      integrityCheck: "ok",
      pageCount: expect.any(Number),
      byteLength: statSync(backupPath).size,
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it("rejects a damaged backup instead of accepting its metadata", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const source = new DatabaseSync(sourcePath);
    databases.push(source);
    source.exec("CREATE TABLE crawl_jobs(id TEXT PRIMARY KEY) STRICT;");
    const metadata = await createSqliteBackup(sourcePath, backupPath);
    await expect(verifySqliteBackup(backupPath, metadata)).resolves.toEqual(metadata);

    writeFileSync(backupPath, Buffer.from("not a sqlite database"));

    await expect(verifySqliteBackup(backupPath, metadata)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "SQLite backup failed integrity verification.",
    });
  });

  it("restores a verified backup to a new readable database", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const restoredPath = join(directory, "restored", "cache.sqlite");
    const source = new DatabaseSync(sourcePath);
    databases.push(source);
    source.exec(`
      CREATE TABLE indexed_pages(id INTEGER PRIMARY KEY, final_url TEXT NOT NULL) STRICT;
      CREATE TABLE crawl_jobs(id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      INSERT INTO indexed_pages(final_url) VALUES ('https://example.com/restored');
      INSERT INTO crawl_jobs(id, status) VALUES ('crawl-1', 'completed');
    `);
    const metadata = await createSqliteBackup(sourcePath, backupPath);

    const result = await restoreSqliteBackup(backupPath, restoredPath, metadata);

    expect(result).toEqual(metadata);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    databases.push(restored);
    expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(restored.prepare("SELECT id, status FROM crawl_jobs").all()).toEqual([
      { id: "crawl-1", status: "completed" },
    ]);
    expect(restored.prepare("SELECT final_url FROM indexed_pages").all()).toEqual([
      { final_url: "https://example.com/restored" },
    ]);
  });

  it("refuses existing backup and restore targets without changing them", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const safeBackupPath = join(directory, "safe-backup.sqlite");
    const restoredPath = join(directory, "restored.sqlite");
    const source = new DatabaseSync(sourcePath);
    databases.push(source);
    source.exec("CREATE TABLE indexed_pages(id INTEGER PRIMARY KEY) STRICT;");
    writeFileSync(backupPath, "existing backup target");

    await expect(createSqliteBackup(sourcePath, backupPath)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "SQLite backup target already exists.",
    });
    expect(readFileSync(backupPath, "utf8")).toBe("existing backup target");

    const metadata = await createSqliteBackup(sourcePath, safeBackupPath);
    writeFileSync(restoredPath, "existing restore target");
    await expect(
      restoreSqliteBackup(safeBackupPath, restoredPath, metadata),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "SQLite restore target already exists.",
    });
    expect(readFileSync(restoredPath, "utf8")).toBe("existing restore target");
  });

  it("cleans its temporary file when a backup attempt fails", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "invalid.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    writeFileSync(sourcePath, "not a sqlite database");

    await expect(createSqliteBackup(sourcePath, backupPath)).rejects.toBeDefined();

    expect(existsSync(backupPath)).toBe(false);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
