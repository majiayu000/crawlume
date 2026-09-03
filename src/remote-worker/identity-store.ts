import { execFile } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

import { InMemoryWorkerIdentity } from "./enrollment.js";

const identityDirectoryName = "worker-identity";
const privateKeyFileName = "private-key.pk8";
const workerIdFileName = "worker-id";
const maximumPrivateKeyBytes = 16 * 1024;
const maximumWorkerIdBytes = 128;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class TransientLinkCountError extends Error {}

type PinnedDirectory = Readonly<{
  path: string;
  handle: FileHandle;
  metadata: BigIntStats;
}>;

type PinnedStore = Readonly<{
  stateChain: readonly PinnedDirectory[];
  identityDirectory: PinnedDirectory;
  effectiveUserId: bigint;
}>;

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

function posixIdentity(): bigint {
  if (
    typeof process.geteuid !== "function" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw storeError();
  }
  return BigInt(process.geteuid());
}

function samePinnedMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode;
}

function runMacOsFileTool(executable: "/bin/chmod" | "/bin/ls", args: string[]): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(executable, args, { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error !== null) {
        rejectResult(storeError());
        return;
      }
      resolveResult(stdout);
    });
  });
}

async function grantingAclState(path: string): Promise<"absent" | "granting" | "missing"> {
  if (process.platform !== "darwin") return "absent";
  let listing: string;
  try {
    listing = await runMacOsFileTool("/bin/ls", ["-lde", path]);
  } catch {
    try {
      await lstat(path);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return "missing";
    }
    throw storeError();
  }
  const entries = listing.match(/^\s+\d+:\s.*$/gmu) ?? [];
  return entries.every((entry) => /\bdeny\b/u.test(entry) && !/\ballow\b/u.test(entry))
    ? "absent"
    : "granting";
}

async function requireNoGrantingAcl(path: string): Promise<void> {
  if (await grantingAclState(path) !== "absent") throw storeError();
}

async function clearExtendedAcl(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await runMacOsFileTool("/bin/chmod", ["-N", path]);
  await requireNoGrantingAcl(path);
}

export function isSecureStateDirectoryAncestor(
  ownerUserId: bigint,
  mode: bigint,
  effectiveUserId: bigint,
): boolean {
  if (ownerUserId === 0n && (mode & 0o1000n) !== 0n) return true;
  return (ownerUserId === 0n || ownerUserId === effectiveUserId) &&
    (mode & 0o022n) === 0n;
}

async function closeHandles(handles: readonly FileHandle[]): Promise<void> {
  let failed = false;
  for (const handle of [...handles].reverse()) {
    try {
      await handle.close();
    } catch {
      failed = true;
    }
  }
  if (failed) throw storeError();
}

async function openDirectory(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw storeError();
  }
}

async function pinDirectory(path: string, handle: FileHandle): Promise<PinnedDirectory> {
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isDirectory()) throw storeError();
    return Object.freeze({ path, handle, metadata });
  } catch {
    throw storeError();
  }
}

function stateDirectoryPrefixes(stateDirectory: string): string[] {
  if (!isAbsolute(stateDirectory) || resolve(stateDirectory) !== stateDirectory) throw storeError();
  const root = parse(stateDirectory).root;
  const prefixes = [root];
  let current = root;
  for (const component of stateDirectory.slice(root.length).split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    prefixes.push(current);
  }
  return prefixes;
}

async function requirePinnedDirectory(directory: PinnedDirectory): Promise<void> {
  try {
    const [handleMetadata, pathMetadata] = await Promise.all([
      directory.handle.stat({ bigint: true }),
      lstat(directory.path, { bigint: true }),
    ]);
    if (
      !handleMetadata.isDirectory() || !pathMetadata.isDirectory() ||
      !samePinnedMetadata(directory.metadata, handleMetadata) ||
      !samePinnedMetadata(directory.metadata, pathMetadata)
    ) {
      throw storeError();
    }
  } catch {
    throw storeError();
  }
}

async function requirePinnedStateChain(stateChain: readonly PinnedDirectory[]): Promise<void> {
  for (const directory of stateChain) await requirePinnedDirectory(directory);
}

async function requirePinnedStore(store: PinnedStore): Promise<void> {
  await requirePinnedStateChain(store.stateChain);
  await requirePinnedDirectory(store.identityDirectory);
}

async function syncPinnedDirectory(directory: PinnedDirectory): Promise<void> {
  try {
    await requirePinnedDirectory(directory);
    await directory.handle.sync();
    await requirePinnedDirectory(directory);
  } catch {
    throw storeError();
  }
}

async function openStateDirectoryChain(
  stateDirectory: string,
  effectiveUserId: bigint,
): Promise<PinnedDirectory[]> {
  const prefixes = stateDirectoryPrefixes(stateDirectory);
  const stateChain: PinnedDirectory[] = [];
  try {
    for (const [index, path] of prefixes.entries()) {
      const handle = await openDirectory(path);
      let pinned: PinnedDirectory;
      try {
        pinned = await pinDirectory(path, handle);
      } catch {
        await closeHandles([handle]);
        throw storeError();
      }
      stateChain.push(pinned);
      await requireNoGrantingAcl(path);
      await requirePinnedDirectory(pinned);
      const stateDirectoryEntry = index === prefixes.length - 1;
      if (stateDirectoryEntry) {
        if (pinned.metadata.uid !== effectiveUserId ||
          (pinned.metadata.mode & 0o7777n) !== 0o700n) throw storeError();
      } else if (!isSecureStateDirectoryAncestor(
        pinned.metadata.uid,
        pinned.metadata.mode,
        effectiveUserId,
      )) throw storeError();
    }
    await requirePinnedStateChain(stateChain);
    return stateChain;
  } catch {
    try {
      await closeHandles(stateChain.map(({ handle }) => handle));
    } catch {
      throw storeError();
    }
    throw storeError();
  }
}

async function openPinnedStore(stateDirectory: string): Promise<PinnedStore> {
  const effectiveUserId = posixIdentity();
  const stateChain = await openStateDirectoryChain(stateDirectory, effectiveUserId);
  const state = stateChain.at(-1);
  if (state === undefined) {
    await closeHandles(stateChain.map(({ handle }) => handle));
    throw storeError();
  }
  const identityPath = join(stateDirectory, identityDirectoryName);
  let identityHandle: FileHandle | undefined;
  try {
    await requirePinnedStateChain(stateChain);
    let created = false;
    try {
      await mkdir(identityPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
    await requirePinnedStateChain(stateChain);
    identityHandle = await openDirectory(identityPath);
    const openedIdentityDirectory = await pinDirectory(identityPath, identityHandle);
    if (created) {
      await clearExtendedAcl(identityPath);
      await identityHandle.chmod(0o700);
      await requirePinnedDirectory(openedIdentityDirectory);
    }
    const identityDirectory = await pinDirectory(identityPath, identityHandle);
    await requireNoGrantingAcl(identityPath);
    await requirePinnedDirectory(identityDirectory);
    if (identityDirectory.metadata.uid !== effectiveUserId ||
      (identityDirectory.metadata.mode & 0o7777n) !== 0o700n) throw storeError();
    const store = Object.freeze({ stateChain, identityDirectory, effectiveUserId });
    await requirePinnedStore(store);
    if (created) {
      await syncPinnedDirectory(identityDirectory);
      await syncPinnedDirectory(state);
      await requirePinnedStore(store);
    }
    return store;
  } catch {
    try {
      await closeHandles([
        ...(identityHandle === undefined ? [] : [identityHandle]),
        ...stateChain.map(({ handle }) => handle),
      ]);
    } catch {
      throw storeError();
    }
    throw storeError();
  }
}

async function withPinnedStore<T>(
  stateDirectory: string,
  operation: (store: PinnedStore) => Promise<T>,
): Promise<T> {
  const store = await openPinnedStore(stateDirectory);
  let result: T | undefined;
  let operationFailure: unknown;
  try {
    result = await operation(store);
    await requirePinnedStore(store);
  } catch (error) {
    operationFailure = error;
  }
  let closeFailed = false;
  try {
    await closeHandles([
      store.identityDirectory.handle,
      ...store.stateChain.map(({ handle }) => handle),
    ]);
  } catch {
    closeFailed = true;
  }
  if (operationFailure !== undefined || closeFailed || result === undefined) throw storeError();
  return result;
}

function validSecretFileMetadata(metadata: BigIntStats, effectiveUserId: bigint): boolean {
  return metadata.isFile() && metadata.uid === effectiveUserId &&
    (metadata.mode & 0o7777n) === 0o600n;
}

async function securePathMetadata(
  store: PinnedStore,
  fileName: string,
): Promise<BigIntStats | null> {
  await requirePinnedStore(store);
  const path = join(store.identityDirectory.path, fileName);
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    await requirePinnedStore(store);
    if (isFileSystemError(error, "ENOENT")) return null;
    throw storeError();
  }
  await requirePinnedStore(store);
  const aclState = await grantingAclState(path);
  if (aclState === "missing") {
    await requirePinnedStore(store);
    return null;
  }
  if (aclState === "granting") throw storeError();
  let verified: BigIntStats;
  try {
    verified = await lstat(path, { bigint: true });
  } catch (error) {
    await requirePinnedStore(store);
    if (isFileSystemError(error, "ENOENT")) return null;
    throw storeError();
  }
  await requirePinnedStore(store);
  if (!samePinnedMetadata(metadata, verified) || metadata.size !== verified.size) throw storeError();
  metadata = verified;
  if (!validSecretFileMetadata(metadata, store.effectiveUserId)) throw storeError();
  return metadata;
}

function temporaryFileName(targetFileName: string): string {
  return `.${targetFileName}.${process.pid}.${randomUUID()}.tmp`;
}

function temporaryFileOwner(name: string, targetFileName: string): number | null | undefined {
  const prefix = `.${targetFileName}.`;
  if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return undefined;
  const identifier = name.slice(prefix.length, -".tmp".length);
  if (canonicalUuidPattern.test(identifier)) return null;
  const separator = identifier.indexOf(".");
  if (separator < 1) return undefined;
  const processId = identifier.slice(0, separator);
  const uuid = identifier.slice(separator + 1);
  if (!/^[1-9][0-9]{0,9}$/u.test(processId) || !canonicalUuidPattern.test(uuid)) {
    return undefined;
  }
  const parsed = Number(processId);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function processIsAlive(processId: number): boolean {
  if (processId === process.pid) return true;
  if (processId >= 2_147_483_647) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ESRCH")) return false;
    if (isFileSystemError(error, "EPERM")) return true;
    throw storeError();
  }
}

async function unlinkPinnedFile(
  store: PinnedStore,
  fileName: string,
  expected: BigIntStats,
): Promise<boolean> {
  await requirePinnedStore(store);
  const path = join(store.identityDirectory.path, fileName);
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    await requirePinnedStore(store);
    if (isFileSystemError(error, "ENOENT")) return false;
    throw storeError();
  }
  if (!samePinnedMetadata(expected, current) || expected.nlink !== current.nlink ||
    !validSecretFileMetadata(current, store.effectiveUserId)) throw storeError();
  try {
    await unlink(path);
  } catch (error) {
    await requirePinnedStore(store);
    if (isFileSystemError(error, "ENOENT")) return false;
    throw storeError();
  }
  await requirePinnedStore(store);
  return true;
}

async function cleanupPublishedTemporaryFiles(
  store: PinnedStore,
  targetFileName: string,
): Promise<boolean> {
  const finalMetadata = await securePathMetadata(store, targetFileName);
  if (finalMetadata === null) return false;
  let names: string[];
  try {
    names = await readdir(store.identityDirectory.path);
  } catch {
    throw storeError();
  }
  await requirePinnedStore(store);
  let removed = false;
  for (const name of names) {
    const owner = temporaryFileOwner(name, targetFileName);
    if (owner === undefined) continue;
    const metadata = await securePathMetadata(store, name);
    if (metadata === null) continue;
    const sameAsFinal = metadata.dev === finalMetadata.dev && metadata.ino === finalMetadata.ino;
    if (!sameAsFinal && metadata.nlink !== 1n) throw storeError();
    if (!sameAsFinal && owner !== null && processIsAlive(owner)) continue;
    removed = await unlinkPinnedFile(store, name, metadata) || removed;
  }
  if (removed) await syncPinnedDirectory(store.identityDirectory);
  await requirePinnedStore(store);
  return true;
}

async function readSecureFile(
  store: PinnedStore,
  fileName: string,
  maximumBytes: number,
): Promise<Buffer | null> {
  await requirePinnedStore(store);
  let handle: FileHandle;
  try {
    handle = await open(
      join(store.identityDirectory.path, fileName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    await requirePinnedStore(store);
    if (isFileSystemError(error, "ENOENT")) return null;
    throw storeError();
  }

  let contents: Buffer | undefined;
  let operationFailed = false;
  let transientLinkCount = false;
  try {
    const before = await handle.stat({ bigint: true });
    if (!validSecretFileMetadata(before, store.effectiveUserId) ||
      before.size < 1n || before.size > BigInt(maximumBytes)) throw storeError();
    if (before.nlink !== 1n) {
      transientLinkCount = true;
      throw new TransientLinkCountError();
    }
    contents = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(
        contents, offset, contents.byteLength - offset, offset,
      );
      if (bytesRead === 0) throw storeError();
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    try {
      if ((await handle.read(probe, 0, 1, contents.byteLength)).bytesRead !== 0) throw storeError();
    } finally {
      probe.fill(0);
    }
    const after = await handle.stat({ bigint: true });
    if (before.nlink !== after.nlink) transientLinkCount = true;
    if (!samePinnedMetadata(before, after) || before.nlink !== after.nlink ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs) throw storeError();
  } catch {
    operationFailed = true;
  }

  let closeFailed = false;
  try {
    await handle.close();
  } catch {
    closeFailed = true;
  }
  let directoryChanged = false;
  try {
    await requirePinnedStore(store);
  } catch {
    directoryChanged = true;
  }
  if (operationFailed || closeFailed || directoryChanged || contents === undefined) {
    contents?.fill(0);
    if (transientLinkCount && !closeFailed && !directoryChanged) {
      throw new TransientLinkCountError();
    }
    throw storeError();
  }
  return contents;
}

async function readStableSecureFile(
  store: PinnedStore,
  fileName: string,
  maximumBytes: number,
): Promise<Buffer | null> {
  try {
    return await readSecureFile(store, fileName, maximumBytes);
  } catch (error) {
    if (!(error instanceof TransientLinkCountError)) throw error;
    await cleanupPublishedTemporaryFiles(store, fileName);
    return readSecureFile(store, fileName, maximumBytes);
  }
}

async function removeOwnTemporaryFile(
  store: PinnedStore,
  fileName: string,
  metadata: BigIntStats | undefined,
): Promise<void> {
  if (metadata !== undefined && await unlinkPinnedFile(store, fileName, metadata)) {
    await syncPinnedDirectory(store.identityDirectory);
  }
}

async function publishSecretFile(
  store: PinnedStore,
  targetFileName: string,
  contents: Uint8Array,
): Promise<boolean> {
  const temporaryName = temporaryFileName(targetFileName);
  const temporaryPath = join(store.identityDirectory.path, temporaryName);
  let handle: FileHandle | undefined;
  let temporaryMetadata: BigIntStats | undefined;
  let creationFailed = false;
  try {
    await requirePinnedStore(store);
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await clearExtendedAcl(temporaryPath);
    await handle.chmod(0o600);
    temporaryMetadata = await handle.stat({ bigint: true });
    if (!validSecretFileMetadata(temporaryMetadata, store.effectiveUserId) ||
      temporaryMetadata.nlink !== 1n) throw storeError();
    const temporaryPathMetadata = await securePathMetadata(store, temporaryName);
    if (temporaryPathMetadata === null ||
      !samePinnedMetadata(temporaryMetadata, temporaryPathMetadata) ||
      temporaryMetadata.nlink !== temporaryPathMetadata.nlink) throw storeError();
    await handle.writeFile(contents);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (!samePinnedMetadata(temporaryMetadata, written) || written.nlink !== 1n ||
      written.size !== BigInt(contents.byteLength)) throw storeError();
    temporaryMetadata = written;
  } catch {
    creationFailed = true;
  }

  let closeFailed = false;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      closeFailed = true;
    }
  }
  if (creationFailed || closeFailed) {
    let cleanupFailed = false;
    try {
      await removeOwnTemporaryFile(store, temporaryName, temporaryMetadata);
    } catch {
      cleanupFailed = true;
    }
    if (creationFailed || closeFailed || cleanupFailed) throw storeError();
  }

  let publicationFailed = false;
  let createdByThisCall = false;
  try {
    await requirePinnedStore(store);
    try {
      await link(temporaryPath, join(store.identityDirectory.path, targetFileName));
      createdByThisCall = true;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST") && !isFileSystemError(error, "ENOENT")) throw error;
      if (await securePathMetadata(store, targetFileName) === null) throw error;
    }
    await syncPinnedDirectory(store.identityDirectory);
    if (!createdByThisCall) await removeOwnTemporaryFile(store, temporaryName, temporaryMetadata);
    if (!await cleanupPublishedTemporaryFiles(store, targetFileName)) throw storeError();
    const finalMetadata = await securePathMetadata(store, targetFileName);
    if (finalMetadata === null || finalMetadata.nlink !== 1n) throw storeError();
  } catch {
    publicationFailed = true;
  }
  if (publicationFailed) {
    let cleanupFailed = false;
    try {
      if (await securePathMetadata(store, targetFileName) === null) {
        await removeOwnTemporaryFile(store, temporaryName, temporaryMetadata);
      } else {
        await cleanupPublishedTemporaryFiles(store, targetFileName);
      }
    } catch {
      cleanupFailed = true;
    }
    if (publicationFailed || cleanupFailed) throw storeError();
  }
  return createdByThisCall;
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
): Promise<Readonly<{ identity: InMemoryWorkerIdentity; createdByThisCall: boolean }>> {
  return withPinnedStore(stateDirectory, async (store) => {
    await cleanupPublishedTemporaryFiles(store, privateKeyFileName);
    const existing = await readStableSecureFile(
      store,
      privateKeyFileName,
      maximumPrivateKeyBytes,
    );
    if (existing !== null) {
      return Object.freeze({
        identity: identityFromPkcs8(existing),
        createdByThisCall: false,
      });
    }

    let generated: Buffer | undefined;
    let createdByThisCall: boolean;
    try {
      const keys = generateKeyPairSync("ed25519");
      generated = keys.privateKey.export({ format: "der", type: "pkcs8" });
      createdByThisCall = await publishSecretFile(store, privateKeyFileName, generated);
    } catch {
      throw storeError();
    } finally {
      generated?.fill(0);
    }
    const persisted = await readStableSecureFile(
      store,
      privateKeyFileName,
      maximumPrivateKeyBytes,
    );
    if (persisted === null) throw storeError();
    return Object.freeze({ identity: identityFromPkcs8(persisted), createdByThisCall });
  });
}

function parseWorkerId(contents: Buffer): string {
  try {
    const workerId = contents.toString("utf8");
    if (!workerId.endsWith("\n")) throw storeError();
    const canonical = workerId.slice(0, -1);
    if (!canonicalUuidPattern.test(canonical)) throw storeError();
    return canonical;
  } finally {
    contents.fill(0);
  }
}

async function loadWorkerIdFromStore(store: PinnedStore): Promise<string | null> {
  await cleanupPublishedTemporaryFiles(store, workerIdFileName);
  const contents = await readStableSecureFile(store, workerIdFileName, maximumWorkerIdBytes);
  return contents === null ? null : parseWorkerId(contents);
}

export async function loadWorkerId(stateDirectory: string): Promise<string | null> {
  return withPinnedStore(stateDirectory, loadWorkerIdFromStore);
}

export async function storeWorkerId(stateDirectory: string, workerId: string): Promise<void> {
  if (!canonicalUuidPattern.test(workerId)) throw storeError();
  await withPinnedStore(stateDirectory, async (store) => {
    const existing = await loadWorkerIdFromStore(store);
    if (existing !== null) {
      if (existing !== workerId) throw storeError();
      return true;
    }
    const serialized = Buffer.from(`${workerId}\n`, "utf8");
    try {
      await publishSecretFile(store, workerIdFileName, serialized);
    } finally {
      serialized.fill(0);
    }
    if (await loadWorkerIdFromStore(store) !== workerId) throw storeError();
    return true;
  });
}
