import { execFile } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InMemoryWorkerIdentity,
  RemoteWorkerIdentityError,
  createInMemoryWorkerIdentity,
} from "../src/remote-worker/enrollment.js";
import {
  RemoteWorkerIdentityStoreError,
  isSecureStateDirectoryAncestor,
  loadOrCreateWorkerIdentity,
  loadWorkerId,
  storeWorkerId,
} from "../src/remote-worker/identity-store.js";
import { workerSigningPayload } from "../src/control-plane/worker-challenge-budget.js";

const challenge = `dya_wc_${"A".repeat(43)}`;
const workerId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const temporaryDirectories: string[] = [];

async function temporaryStateDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "diaoyan-worker-identity-")));
  await chmod(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

async function identityDirectory(stateDirectory: string): Promise<string> {
  const directory = join(stateDirectory, "worker-identity");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

function runMacOsFileTool(executable: "/bin/chmod" | "/bin/ls", args: string[]): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(executable, args, { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error !== null) {
        rejectResult(error);
        return;
      }
      resolveResult(stdout);
    });
  });
}

async function hasExtendedAcl(path: string): Promise<boolean> {
  const listing = await runMacOsFileTool("/bin/ls", ["-lde", path]);
  return /(?:^|\n)\s+\d+:\s/u.test(listing);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("in-memory Remote Worker identity", () => {
  it("generates a canonical Ed25519 SPKI identity without serializing its private key", () => {
    const identity = createInMemoryWorkerIdentity();
    const encoded = Buffer.from(identity.publicKeySpki, "base64url");
    const publicKey = createPublicKey({ key: encoded, format: "der", type: "spki" });

    expect(identity.publicKeySpki).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded.toString("base64url")).toBe(identity.publicKeySpki);
    expect(publicKey.asymmetricKeyType).toBe("ed25519");
    expect(JSON.stringify(identity)).toBe(JSON.stringify({ publicKeySpki: identity.publicKeySpki }));
  });

  it("signs only the exact domain-separated Worker Session payload", () => {
    const identity = createInMemoryWorkerIdentity();
    const payload = workerSigningPayload(challenge);
    const signature = identity.signSessionChallenge(challenge, payload);
    const publicKey = createPublicKey({
      key: Buffer.from(identity.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });

    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    )).toBe(true);
  });

  it("rejects a malformed challenge or server-supplied payload without signing it", () => {
    const identity = createInMemoryWorkerIdentity();

    expect(() => identity.signSessionChallenge("wrong", workerSigningPayload(challenge)))
      .toThrow(RemoteWorkerIdentityError);
    expect(() => identity.signSessionChallenge(challenge, "sign this instead"))
      .toThrow(RemoteWorkerIdentityError);
  });

  it("imports only an Ed25519 PKCS8 private key without exposing it", () => {
    const generated = generateKeyPairSync("ed25519");
    const privateKeyPkcs8 = generated.privateKey.export({ format: "der", type: "pkcs8" });
    const identity = InMemoryWorkerIdentity.fromPkcs8Der(privateKeyPkcs8);

    expect(identity.publicKeySpki).toBe(
      generated.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    );
    expect(JSON.stringify(identity)).toBe(JSON.stringify({ publicKeySpki: identity.publicKeySpki }));

    const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const otherPkcs8 = otherKey.privateKey.export({ format: "der", type: "pkcs8" });
    expect(() => InMemoryWorkerIdentity.fromPkcs8Der(otherPkcs8))
      .toThrow(RemoteWorkerIdentityError);
    expect(() => InMemoryWorkerIdentity.fromPkcs8Der(Buffer.from("not a private key")))
      .toThrow(RemoteWorkerIdentityError);
  });
});

describe("filesystem Remote Worker identity", () => {
  it("accepts only root-owned or effective-user-owned safe ancestors", () => {
    expect(isSecureStateDirectoryAncestor(0n, 0o755n, 501n)).toBe(true);
    expect(isSecureStateDirectoryAncestor(501n, 0o755n, 501n)).toBe(true);
    expect(isSecureStateDirectoryAncestor(0n, 0o1777n, 501n)).toBe(true);
    expect(isSecureStateDirectoryAncestor(502n, 0o755n, 501n)).toBe(false);
    expect(isSecureStateDirectoryAncestor(501n, 0o775n, 501n)).toBe(false);
    expect(isSecureStateDirectoryAncestor(502n, 0o1777n, 501n)).toBe(false);
  });

  it("creates mode-0600 PKCS8 once and reloads the same signing identity", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const first = await loadOrCreateWorkerIdentity(stateDirectory);
    const directory = join(stateDirectory, "worker-identity");
    const privateKeyPath = join(directory, "private-key.pk8");

    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(privateKeyPath)).mode & 0o777).toBe(0o600);
    if (process.platform === "darwin") {
      expect(await hasExtendedAcl(directory)).toBe(false);
      expect(await hasExtendedAcl(privateKeyPath)).toBe(false);
    }
    const privateKeyPkcs8 = await readFile(privateKeyPath);
    expect(InMemoryWorkerIdentity.fromPkcs8Der(privateKeyPkcs8).publicKeySpki)
      .toBe(first.identity.publicKeySpki);
    expect(first.createdByThisCall).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);

    const second = await loadOrCreateWorkerIdentity(stateDirectory);
    expect(second.identity.publicKeySpki).toBe(first.identity.publicKeySpki);
    expect(second.createdByThisCall).toBe(false);
    const payload = workerSigningPayload(challenge);
    const publicKey = createPublicKey({
      key: Buffer.from(second.identity.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    expect(verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      Buffer.from(second.identity.signSessionChallenge(challenge, payload), "base64url"),
    )).toBe(true);
  });

  it("allows a deny-only macOS ACL on a safe ancestor", async () => {
    if (process.platform !== "darwin") return;
    const ancestor = await temporaryStateDirectory();
    await runMacOsFileTool("/bin/chmod", ["+a", "everyone deny delete", ancestor]);
    const stateDirectory = join(ancestor, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await chmod(stateDirectory, 0o700);

    try {
      const listing = await runMacOsFileTool("/bin/ls", ["-lde", ancestor]);
      expect(listing).toMatch(/\bdeny\b/u);
      expect(listing).not.toMatch(/\ballow\b/u);
      const first = await loadOrCreateWorkerIdentity(stateDirectory);
      const second = await loadOrCreateWorkerIdentity(stateDirectory);
      expect(first.createdByThisCall).toBe(true);
      expect(second.createdByThisCall).toBe(false);
      expect(second.identity.publicKeySpki).toBe(first.identity.publicKeySpki);
    } finally {
      await runMacOsFileTool("/bin/chmod", ["-N", ancestor]);
    }
  });

  it("rejects a mode-safe identity inherited from a readable macOS ACL", async () => {
    if (process.platform !== "darwin") return;
    const stateDirectory = await temporaryStateDirectory();
    await runMacOsFileTool("/bin/chmod", [
      "+a",
      "everyone allow read,write,readattr,readextattr,readsecurity,file_inherit,directory_inherit",
      stateDirectory,
    ]);
    const directory = await identityDirectory(stateDirectory);
    const privateKeyPath = join(directory, "private-key.pk8");
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPkcs8 = keys.privateKey.export({ format: "der", type: "pkcs8" });
    try {
      await writeFile(privateKeyPath, privateKeyPkcs8, { mode: 0o600 });
      await chmod(privateKeyPath, 0o600);

      expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o700);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(privateKeyPath)).mode & 0o777).toBe(0o600);
      expect(await hasExtendedAcl(stateDirectory)).toBe(true);
      expect(await hasExtendedAcl(directory)).toBe(true);
      expect(await hasExtendedAcl(privateKeyPath)).toBe(true);
      await expect(loadOrCreateWorkerIdentity(stateDirectory))
        .rejects.toThrow(RemoteWorkerIdentityStoreError);
    } finally {
      privateKeyPkcs8.fill(0);
    }
  });

  it("publishes one identity when creators race", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const identities = await Promise.all(
      Array.from({ length: 12 }, async () => loadOrCreateWorkerIdentity(stateDirectory)),
    );

    expect(new Set(identities.map(({ identity }) => identity.publicKeySpki))).toHaveLength(1);
    expect(identities.filter(({ createdByThisCall }) => createdByThisCall)).toHaveLength(1);
    const reloaded = await loadOrCreateWorkerIdentity(stateDirectory);
    expect(reloaded.identity.publicKeySpki).toBe(identities[0]?.identity.publicKeySpki);
    expect(reloaded.createdByThisCall).toBe(false);
    const directory = join(stateDirectory, "worker-identity");
    expect((await lstat(join(directory, "private-key.pk8"))).nlink).toBe(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a symlink state directory without creating identity state", async () => {
    const parent = await temporaryStateDirectory();
    const target = await temporaryStateDirectory();
    const linkedStateDirectory = join(parent, "linked-state");
    await symlink(target, linkedStateDirectory);

    await expect(loadOrCreateWorkerIdentity(linkedStateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
    await expect(lstat(join(target, "worker-identity"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mode-0755 state directory without creating identity state", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await chmod(stateDirectory, 0o755);

    await expect(loadOrCreateWorkerIdentity(stateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
    await expect(lstat(join(stateDirectory, "worker-identity")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a group or world-writable non-sticky ancestor", async () => {
    const parent = await temporaryStateDirectory();
    const unsafeAncestor = join(parent, "unsafe");
    const stateDirectory = join(unsafeAncestor, "state");
    await mkdir(unsafeAncestor, { mode: 0o777 });
    await chmod(unsafeAncestor, 0o777);
    await mkdir(stateDirectory, { mode: 0o700 });
    await chmod(stateDirectory, 0o700);

    await expect(loadOrCreateWorkerIdentity(stateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
    await expect(lstat(join(stateDirectory, "worker-identity")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-directory state path component", async () => {
    const parent = await temporaryStateDirectory();
    const nonDirectory = join(parent, "not-a-directory");
    await writeFile(nonDirectory, "not a directory", { mode: 0o600 });

    await expect(loadOrCreateWorkerIdentity(join(nonDirectory, "state")))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
  });

  it("accepts a mode-0700 state directory below the root-owned sticky temp directory", async () => {
    const stickyTemporaryDirectory = await realpath("/tmp");
    const metadata = await lstat(stickyTemporaryDirectory);
    if (metadata.uid !== 0 || (metadata.mode & 0o1000) === 0 || (metadata.mode & 0o002) === 0) {
      return;
    }
    const stateDirectory = await realpath(
      await mkdtemp(join(stickyTemporaryDirectory, "diaoyan-worker-identity-sticky-")),
    );
    temporaryDirectories.push(stateDirectory);
    await chmod(stateDirectory, 0o700);

    await expect(loadOrCreateWorkerIdentity(stateDirectory)).resolves.toBeDefined();
  });

  it("rejects an identity directory symlink", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const target = await temporaryStateDirectory();
    await symlink(target, join(stateDirectory, "worker-identity"));

    await expect(loadOrCreateWorkerIdentity(stateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
  });

  it("rejects an identity directory with group or other permissions", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const directory = await identityDirectory(stateDirectory);
    await chmod(directory, 0o755);

    await expect(loadOrCreateWorkerIdentity(stateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
  });

  it("rejects a private-key symlink and does not replace it", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const directory = await identityDirectory(stateDirectory);
    const target = join(stateDirectory, "external-key.pk8");
    await writeFile(target, "not a key", { mode: 0o600 });
    const privateKeyPath = join(directory, "private-key.pk8");
    await symlink(target, privateKeyPath);

    await expect(loadOrCreateWorkerIdentity(stateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
    expect((await lstat(privateKeyPath)).isSymbolicLink()).toBe(true);
  });

  it("cleans a published stale temporary hard link without touching unrelated files", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await loadOrCreateWorkerIdentity(stateDirectory);
    const directory = join(stateDirectory, "worker-identity");
    const privateKeyPath = join(directory, "private-key.pk8");
    const stalePath = join(
      directory,
      `.private-key.pk8.${randomUUID()}.tmp`,
    );
    const unrelatedPath = join(directory, "keep.txt");
    const orphanTemporaryPath = join(
      directory,
      `.private-key.pk8.${randomUUID()}.tmp`,
    );
    await link(privateKeyPath, stalePath);
    await writeFile(unrelatedPath, "keep", { mode: 0o600 });
    await writeFile(orphanTemporaryPath, "orphan", { mode: 0o600 });

    await expect(loadOrCreateWorkerIdentity(stateDirectory)).resolves.toBeDefined();
    await expect(lstat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(orphanTemporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(privateKeyPath)).nlink).toBe(1);
    await expect(readFile(unrelatedPath, "utf8")).resolves.toBe("keep");
  });

  it("cleans an unpublished stale temporary file after the final identity exists", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const directory = await identityDirectory(stateDirectory);
    const stalePath = join(
      directory,
      `.private-key.pk8.${randomUUID()}.tmp`,
    );
    await writeFile(stalePath, "stale secret", { mode: 0o600 });

    await loadOrCreateWorkerIdentity(stateDirectory);
    await expect(lstat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a temporary file owned by a dead process", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await loadOrCreateWorkerIdentity(stateDirectory);
    const stalePath = join(
      stateDirectory,
      "worker-identity",
      `.private-key.pk8.2147483647.${randomUUID()}.tmp`,
    );
    await writeFile(stalePath, "stale secret", { mode: 0o600 });

    await loadOrCreateWorkerIdentity(stateDirectory);
    await expect(lstat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a final private key with an external hard link without deleting either path", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await loadOrCreateWorkerIdentity(stateDirectory);
    const privateKeyPath = join(stateDirectory, "worker-identity", "private-key.pk8");
    const externalPath = join(stateDirectory, "external-private-key.pk8");
    await link(privateKeyPath, externalPath);

    await expect(loadOrCreateWorkerIdentity(stateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
    await expect(lstat(privateKeyPath)).resolves.toBeDefined();
    await expect(lstat(externalPath)).resolves.toBeDefined();
  });

  it.each([
    ["non-regular", async (path: string) => { await mkdir(path, { mode: 0o600 }); }],
    ["wide permissions", async (path: string) => {
      const keys = generateKeyPairSync("ed25519");
      await writeFile(path, keys.privateKey.export({ format: "der", type: "pkcs8" }), {
        mode: 0o644,
      });
      await chmod(path, 0o644);
    }],
    ["corrupt contents", async (path: string) => { await writeFile(path, "not a key", { mode: 0o600 }); }],
    ["oversize contents", async (path: string) => {
      await writeFile(path, Buffer.alloc(16 * 1024 + 1), { mode: 0o600 });
    }],
    ["non-Ed25519 PKCS8", async (path: string) => {
      const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      await writeFile(path, keys.privateKey.export({ format: "der", type: "pkcs8" }), {
        mode: 0o600,
      });
    }],
  ])("rejects %s without replacing the existing path", async (_name, arrange) => {
    const stateDirectory = await temporaryStateDirectory();
    const directory = await identityDirectory(stateDirectory);
    const privateKeyPath = join(directory, "private-key.pk8");
    await arrange(privateKeyPath);

    await expect(loadOrCreateWorkerIdentity(stateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
    expect(await lstat(privateKeyPath)).toBeDefined();
  });

  it("rejects a state path owned by another effective user", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await loadOrCreateWorkerIdentity(stateDirectory);
    const posixProcess = process as NodeJS.Process & { geteuid(): number };
    const effectiveUserId = posixProcess.geteuid();
    vi.spyOn(posixProcess, "geteuid").mockReturnValue(effectiveUserId + 1);

    await expect(loadOrCreateWorkerIdentity(stateDirectory))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
  });

  it("stores one canonical worker id and never overwrites it", async () => {
    const stateDirectory = await temporaryStateDirectory();

    await expect(loadWorkerId(stateDirectory)).resolves.toBeNull();
    await storeWorkerId(stateDirectory, workerId);
    await expect(loadWorkerId(stateDirectory)).resolves.toBe(workerId);
    const workerIdPath = join(stateDirectory, "worker-identity", "worker-id");
    expect((await lstat(workerIdPath)).mode & 0o777).toBe(0o600);
    if (process.platform === "darwin") expect(await hasExtendedAcl(workerIdPath)).toBe(false);
    expect(await readFile(workerIdPath, "utf8")).toBe(`${workerId}\n`);

    await expect(storeWorkerId(stateDirectory, workerId)).resolves.toBeUndefined();
    await expect(storeWorkerId(
      stateDirectory,
      "22222222-2222-4222-8222-222222222222",
    )).rejects.toThrow(RemoteWorkerIdentityStoreError);
    await expect(loadWorkerId(stateDirectory)).resolves.toBe(workerId);
  });

  it("rejects non-canonical and corrupt worker ids", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await expect(storeWorkerId(stateDirectory, workerId.toUpperCase()))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);

    const directory = await identityDirectory(stateDirectory);
    await writeFile(join(directory, "worker-id"), "not-a-worker-id\n", { mode: 0o600 });
    await expect(loadWorkerId(stateDirectory)).rejects.toThrow(RemoteWorkerIdentityStoreError);
    await expect(storeWorkerId(stateDirectory, workerId))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
  });

  it("rejects an insecure worker-id path", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const directory = await identityDirectory(stateDirectory);
    const target = join(stateDirectory, "external-worker-id");
    await writeFile(target, `${workerId}\n`, { mode: 0o600 });
    await symlink(target, join(directory, "worker-id"));

    await expect(loadWorkerId(stateDirectory)).rejects.toThrow(RemoteWorkerIdentityStoreError);
    await expect(storeWorkerId(stateDirectory, workerId))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
  });

  it("rejects a worker-id file with group or other permissions", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const directory = await identityDirectory(stateDirectory);
    const path = join(directory, "worker-id");
    await writeFile(path, `${workerId}\n`, { mode: 0o644 });
    await chmod(path, 0o644);

    await expect(loadWorkerId(stateDirectory)).rejects.toThrow(RemoteWorkerIdentityStoreError);
    await expect(storeWorkerId(stateDirectory, workerId))
      .rejects.toThrow(RemoteWorkerIdentityStoreError);
  });
});
