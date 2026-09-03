import { generateKeyPairSync, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { InMemoryWorkerIdentity } from "./enrollment.js";

const identityDirectoryName = "worker-identity";
const privateKeyFileName = "private-key.pk8";
const workerIdFileName = "worker-id";
const maximumPrivateKeyBytes = 16 * 1024;
const maximumWorkerIdBytes = 128;
const canonicalWorkerIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class RemoteWorkerIdentityStoreError extends Error {
  constructor() {
    super("The Remote Worker identity store is unavailable or insecure.");
    this.name = "RemoteWorkerIdentityStoreError";
  }
}

function storeError(): RemoteWorkerIdentityStoreError {
  return new RemoteWorkerIdentityStoreError();
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function effectiveUserId(): number {
  if (typeof process.geteuid !== "function" || constants.O_NOFOLLOW === undefined) {
    throw storeError();
  }
  return process.geteuid();
}

function requireAbsoluteStateDirectory(stateDirectory: string): void {
  if (!isAbsolute(stateDirectory)) throw storeError();
}

async function ensureIdentityDirectory(stateDirectory: string): Promise<string> {
  requireAbsoluteStateDirectory(stateDirectory);
  const directory = join(stateDirectory, identityDirectoryName);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw storeError();
  }
  try {
    if (created) await chmod(directory, 0o700);
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== effectiveUserId() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw storeError();
    }
  } catch {
    throw storeError();
  }
  return directory;
}

async function readSecureFile(path: string, maximumBytes: number): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw storeError();
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== effectiveUserId() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size < 1 ||
      before.size > maximumBytes
    ) {
      throw storeError();
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      after.uid !== before.uid ||
      after.mode !== before.mode ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      contents.byteLength !== before.size
    ) {
      contents.fill(0);
      throw storeError();
    }
    return contents;
  } catch {
    throw storeError();
  } finally {
    try {
      await handle.close();
    } catch {
      throw storeError();
    }
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw storeError();
  }
}

async function publishSecretFile(path: string, contents: Uint8Array): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let operationError: unknown;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await removeTemporaryFile(temporaryPath);
  } catch (error) {
    cleanupError ??= error;
  }
  if (operationError !== undefined || cleanupError !== undefined) throw storeError();
}

function identityFromPkcs8(pkcs8Der: Buffer): InMemoryWorkerIdentity {
  try {
    return InMemoryWorkerIdentity.fromPkcs8Der(pkcs8Der);
  } catch {
    throw storeError();
  } finally {
    pkcs8Der.fill(0);
  }
}

export async function loadOrCreateWorkerIdentity(
  stateDirectory: string,
): Promise<InMemoryWorkerIdentity> {
  const directory = await ensureIdentityDirectory(stateDirectory);
  const privateKeyPath = join(directory, privateKeyFileName);
  const existing = await readSecureFile(privateKeyPath, maximumPrivateKeyBytes);
  if (existing !== null) return identityFromPkcs8(existing);

  const keys = generateKeyPairSync("ed25519");
  const generated = keys.privateKey.export({ format: "der", type: "pkcs8" });
  try {
    await publishSecretFile(privateKeyPath, generated);
  } finally {
    generated.fill(0);
  }
  const persisted = await readSecureFile(privateKeyPath, maximumPrivateKeyBytes);
  if (persisted === null) throw storeError();
  return identityFromPkcs8(persisted);
}

function parseWorkerId(contents: Buffer): string {
  try {
    const workerId = contents.toString("utf8");
    if (!workerId.endsWith("\n")) throw storeError();
    const canonical = workerId.slice(0, -1);
    if (!canonicalWorkerIdPattern.test(canonical)) throw storeError();
    return canonical;
  } finally {
    contents.fill(0);
  }
}

async function loadWorkerIdFromDirectory(directory: string): Promise<string | null> {
  const contents = await readSecureFile(join(directory, workerIdFileName), maximumWorkerIdBytes);
  return contents === null ? null : parseWorkerId(contents);
}

export async function loadWorkerId(stateDirectory: string): Promise<string | null> {
  const directory = await ensureIdentityDirectory(stateDirectory);
  return loadWorkerIdFromDirectory(directory);
}

export async function storeWorkerId(stateDirectory: string, workerId: string): Promise<void> {
  if (!canonicalWorkerIdPattern.test(workerId)) throw storeError();
  const directory = await ensureIdentityDirectory(stateDirectory);
  const existing = await loadWorkerIdFromDirectory(directory);
  if (existing !== null) {
    if (existing !== workerId) throw storeError();
    return;
  }

  const serialized = Buffer.from(`${workerId}\n`, "utf8");
  try {
    await publishSecretFile(join(directory, workerIdFileName), serialized);
  } finally {
    serialized.fill(0);
  }
  if (await loadWorkerIdFromDirectory(directory) !== workerId) throw storeError();
}
