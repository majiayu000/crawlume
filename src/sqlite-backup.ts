import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import { logEvent } from "./log.js";

export type SqliteBackupMetadata = {
  format: "crawlume-sqlite-backup-v1";
  createdAt: string;
  integrityCheck: "ok";
  pageCount: number;
  byteLength: number;
  sha256: `sha256:${string}`;
};

export type CreateSqliteBackupOptions = {
  now?: () => Date;
};

type IntegrityRow = { integrity_check: string };
type PageCountRow = { page_count: number };

function invalidBackup(message: string, path: string, cause?: unknown): ReadError {
  return new ReadError("INVALID_ARGUMENT", message, {
    details: { path },
    ...(cause === undefined ? {} : { cause }),
  });
}

function requireRegularFile(path: string, label: string): void {
  try {
    if (!statSync(path).isFile()) throw invalidBackup(`${label} must be a regular file.`, path);
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw invalidBackup(`${label} must be an existing regular file.`, path, error);
  }
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest("hex")}`;
}

async function inspectSqliteBackup(
  path: string,
): Promise<Omit<SqliteBackupMetadata, "format" | "createdAt">> {
  requireRegularFile(path, "SQLite backup");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    const rows = database.prepare("PRAGMA integrity_check").all() as unknown as IntegrityRow[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw invalidBackup("SQLite backup failed integrity verification.", path);
    }
    const page = database.prepare("PRAGMA page_count").get() as PageCountRow;
    const byteLength = statSync(path).size;
    return {
      integrityCheck: "ok",
      pageCount: page.page_count,
      byteLength,
      sha256: await sha256File(path),
    };
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw invalidBackup("SQLite backup failed integrity verification.", path, error);
  } finally {
    try {
      database?.close();
    } catch (error) {
      logEvent("warn", "sqlite.backup.inspection_close_failed", { path, error: String(error) });
    }
  }
}

function temporaryPath(targetPath: string): string {
  return `${dirname(targetPath)}/.${basename(targetPath)}.${randomUUID()}.tmp`;
}

function removePendingSqliteFiles(pendingPath: string): void {
  for (const path of [pendingPath, `${pendingPath}-wal`, `${pendingPath}-shm`, `${pendingPath}-journal`]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logEvent("warn", "sqlite.temporary_file.cleanup_failed", { path, error: String(error) });
      }
    }
  }
}

function requireAbsentTarget(path: string, operation: "backup" | "restore"): void {
  if (existsSync(path)) {
    throw invalidBackup(`SQLite ${operation} target already exists.`, path);
  }
}

function publishWithoutOverwrite(
  pendingPath: string,
  targetPath: string,
  operation: "backup" | "restore",
): void {
  try {
    linkSync(pendingPath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw invalidBackup(`SQLite ${operation} target already exists.`, targetPath, error);
    }
    throw error;
  }
}

function requireMetadata(metadata: SqliteBackupMetadata, path: string): void {
  if (
    typeof metadata !== "object" || metadata === null || Array.isArray(metadata) ||
    metadata.format !== "crawlume-sqlite-backup-v1" ||
    metadata.integrityCheck !== "ok" ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    !Number.isSafeInteger(metadata.pageCount) ||
    metadata.pageCount <= 0 ||
    !Number.isSafeInteger(metadata.byteLength) ||
    metadata.byteLength <= 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(metadata.sha256)
  ) {
    throw invalidBackup("SQLite backup metadata is invalid.", path);
  }
}

async function verifyStagedSqliteBackup(
  backupPath: string,
  metadata: SqliteBackupMetadata,
): Promise<SqliteBackupMetadata> {
  const actual = await inspectSqliteBackup(backupPath);
  if (
    actual.integrityCheck !== metadata.integrityCheck ||
    actual.pageCount !== metadata.pageCount ||
    actual.byteLength !== metadata.byteLength ||
    actual.sha256 !== metadata.sha256
  ) {
    throw invalidBackup("SQLite backup does not match its verification metadata.", backupPath);
  }
  return metadata;
}

export async function verifySqliteBackup(
  backupPath: string,
  metadata: SqliteBackupMetadata,
): Promise<SqliteBackupMetadata> {
  requireMetadata(metadata, backupPath);
  requireRegularFile(backupPath, "SQLite backup");
  // WAL-mode snapshots can create sidecars even when opened read-only.
  const staging = mkdtempSync(join(tmpdir(), "crawlume-verify-"));
  const stagedBackup = join(staging, "backup.sqlite");
  try {
    copyFileSync(backupPath, stagedBackup, fsConstants.COPYFILE_EXCL);
    chmodSync(stagedBackup, 0o600);
    return await verifyStagedSqliteBackup(stagedBackup, metadata);
  } finally {
    try {
      rmSync(staging, { recursive: true });
    } catch (error) {
      logEvent("warn", "sqlite.backup.verification_cleanup_failed", { path: staging, error: String(error) });
    }
  }
}

export async function restoreSqliteBackup(
  backupPath: string,
  targetPath: string,
  metadata: SqliteBackupMetadata,
): Promise<SqliteBackupMetadata> {
  if (resolve(backupPath) === resolve(targetPath)) {
    throw invalidBackup("SQLite restore target must differ from the backup.", targetPath);
  }
  // A restore target must be offline; stale journals can overwrite the verified snapshot.
  for (const path of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`, `${targetPath}-journal`]) {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw invalidBackup("SQLite restore target or journal already exists.", path);
  }
  requireMetadata(metadata, backupPath);
  requireRegularFile(backupPath, "SQLite backup");
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const pendingPath = temporaryPath(targetPath);
  try {
    copyFileSync(backupPath, pendingPath, fsConstants.COPYFILE_EXCL);
    chmodSync(pendingPath, 0o600);
    await verifyStagedSqliteBackup(pendingPath, metadata);
    publishWithoutOverwrite(pendingPath, targetPath, "restore");
    return metadata;
  } finally {
    removePendingSqliteFiles(pendingPath);
  }
}

export async function createSqliteBackup(
  sourcePath: string,
  backupPath: string,
  options: CreateSqliteBackupOptions = {},
): Promise<SqliteBackupMetadata> {
  requireRegularFile(sourcePath, "SQLite source");
  if (resolve(sourcePath) === resolve(backupPath)) {
    throw invalidBackup("SQLite backup target must differ from the source.", backupPath);
  }
  requireAbsentTarget(backupPath, "backup");
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  const pendingPath = temporaryPath(backupPath);
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
    await backup(source, pendingPath);
    chmodSync(pendingPath, 0o600);
    const verification = await inspectSqliteBackup(pendingPath);
    const metadata: SqliteBackupMetadata = {
      format: "crawlume-sqlite-backup-v1",
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      ...verification,
    };
    publishWithoutOverwrite(pendingPath, backupPath, "backup");
    return metadata;
  } finally {
    try {
      source?.close();
    } catch (error) {
      logEvent("warn", "sqlite.backup.source_close_failed", { path: sourcePath, error: String(error) });
    }
    removePendingSqliteFiles(pendingPath);
  }
}
