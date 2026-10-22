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
import { afterEach, describe, expect, it, vi } from "vitest";

const failures = vi.hoisted(() => ({ unlinkTemporary: false, unlinkAttempts: 0, tamperCopy: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (String(args[0]).endsWith(".tmp")) {
        failures.unlinkAttempts += 1;
        if (failures.unlinkTemporary) throw Object.assign(new Error("pending unlink denied"), { code: "EACCES" });
      }
      return actual.unlinkSync(...args);
    },
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      actual.copyFileSync(...args);
      if (failures.tamperCopy) actual.writeFileSync(args[1], "not a sqlite database");
    },
  };
});

import { ReadError } from "../src/errors.js";

import {
  createSqliteBackup,
  restoreSqliteBackup,
  verifySqliteBackup,
} from "../src/sqlite-backup.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  failures.unlinkTemporary = false;
  failures.unlinkAttempts = 0;
  failures.tamperCopy = false;
  vi.restoreAllMocks();
  while (databases.length > 0) databases.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "crawlume-sqlite-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("SQLite backup and recovery", () => {
  it("keeps a verified restore successful when pending unlink fails", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const source = new DatabaseSync(sourcePath); databases.push(source);
    source.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY) STRICT;");
    const backupPath = join(directory, "backup.sqlite");
    const metadata = await createSqliteBackup(sourcePath, backupPath);
    const targetPath = join(directory, "restored.sqlite");
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    failures.unlinkTemporary = true;
    await expect(restoreSqliteBackup(backupPath, targetPath, metadata)).resolves.toEqual(metadata);
    await expect(verifySqliteBackup(targetPath, metadata)).resolves.toEqual(metadata);
    expect(readdirSync(directory).some((name) => name.startsWith(".restored.sqlite.") && name.endsWith(".tmp"))).toBe(true);
    expect(errors.mock.calls.some(([text]) => JSON.parse(String(text)).event === "sqlite.temporary_file.cleanup_failed")).toBe(true);
  });

  it("preserves a restore verification error when pending cleanup also fails", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const source = new DatabaseSync(sourcePath); databases.push(source);
    source.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY) STRICT;");
    const backupPath = join(directory, "backup.sqlite");
    const metadata = await createSqliteBackup(sourcePath, backupPath);
    const targetPath = join(directory, "restored.sqlite");
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    failures.tamperCopy = true;
    failures.unlinkTemporary = true;
    await expect(restoreSqliteBackup(backupPath, targetPath, metadata)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT", message: "SQLite backup failed integrity verification.",
    });
    expect(existsSync(targetPath)).toBe(false);
    expect(errors.mock.calls.some(([text]) => JSON.parse(String(text)).event === "sqlite.temporary_file.cleanup_failed")).toBe(true);
  });

  it("keeps a verified backup successful when pending unlink fails", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const source = new DatabaseSync(sourcePath); databases.push(source);
    source.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY) STRICT;");
    const backupPath = join(directory, "backup.sqlite");
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    failures.unlinkTemporary = true;
    const metadata = await createSqliteBackup(sourcePath, backupPath);
    await expect(verifySqliteBackup(backupPath, metadata)).resolves.toEqual(metadata);
    expect(readdirSync(directory).some((name) => name.startsWith(".backup.sqlite.") && name.endsWith(".tmp"))).toBe(true);
    expect(errors.mock.calls.some(([text]) => JSON.parse(String(text)).event === "sqlite.temporary_file.cleanup_failed")).toBe(true);
  });

  it("still unlinks pending files after database close fails on a successful backup", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const source = new DatabaseSync(sourcePath); databases.push(source);
    source.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY) STRICT;");
    const originalClose = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      originalClose.call(this);
      throw new Error("close denied");
    });
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const backupPath = join(directory, "backup.sqlite");
    const metadata = await createSqliteBackup(sourcePath, backupPath);
    await expect(verifySqliteBackup(backupPath, metadata)).resolves.toEqual(metadata);
    expect(failures.unlinkAttempts).toBeGreaterThan(0);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(errors.mock.calls.some(([text]) => JSON.parse(String(text)).event === "sqlite.backup.source_close_failed")).toBe(true);
  });

  it("preserves a primary backup error when close and pending unlink both fail", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const source = new DatabaseSync(sourcePath); databases.push(source);
    source.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY) STRICT;");
    const originalClose = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      originalClose.call(this);
      throw new Error("close denied");
    });
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    failures.unlinkTemporary = true;
    const primary = new ReadError("INVALID_ARGUMENT", "primary backup failure");
    const backupPath = join(directory, "backup.sqlite");
    await expect(createSqliteBackup(sourcePath, backupPath, { now: () => { throw primary; } })).rejects.toBe(primary);
    expect(existsSync(backupPath)).toBe(false);
    expect(failures.unlinkAttempts).toBeGreaterThan(0);
    const events = errors.mock.calls.map(([text]) => JSON.parse(String(text)).event);
    expect(events).toContain("sqlite.backup.source_close_failed");
    expect(events).toContain("sqlite.temporary_file.cleanup_failed");
  });

  it("preserves an inspection integrity error when its database close also fails", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const source = new DatabaseSync(sourcePath); databases.push(source);
    source.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY) STRICT;");
    const backupPath = join(directory, "backup.sqlite");
    const metadata = await createSqliteBackup(sourcePath, backupPath);
    writeFileSync(backupPath, "not a sqlite database");
    const originalClose = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      originalClose.call(this);
      throw new Error("close denied");
    });
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(verifySqliteBackup(backupPath, metadata)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT", message: "SQLite backup failed integrity verification.",
    });
    expect(errors.mock.calls.some(([text]) => JSON.parse(String(text)).event === "sqlite.backup.inspection_close_failed")).toBe(true);
  });

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
      format: "crawlume-sqlite-backup-v1",
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
      message: "SQLite restore target or journal already exists.",
    });
    expect(readFileSync(restoredPath, "utf8")).toBe("existing restore target");
  });

  it.each(["-wal", "-shm", "-journal"])("rejects a stale %s beside an absent restore target", async (suffix) => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const targetPath = join(directory, "restored.sqlite");
    const source = new DatabaseSync(sourcePath);
    databases.push(source);
    source.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY) STRICT;");
    const metadata = await createSqliteBackup(sourcePath, backupPath);
    writeFileSync(`${targetPath}${suffix}`, "stale journal");
    await expect(restoreSqliteBackup(backupPath, targetPath, metadata)).rejects.toThrow("journal already exists");
    expect(existsSync(targetPath)).toBe(false);
    expect(readFileSync(`${targetPath}${suffix}`, "utf8")).toBe("stale journal");
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
