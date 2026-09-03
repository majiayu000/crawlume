import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  loadOrCreateWorkerIdentity,
  loadWorkerId,
  storeWorkerId,
} from "../src/remote-worker/identity-store.js";
import { workerSigningPayload } from "../src/control-plane/worker-challenge-budget.js";

const challenge = `dya_wc_${"A".repeat(43)}`;
const workerId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const temporaryDirectories: string[] = [];

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diaoyan-worker-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function identityDirectory(stateDirectory: string): Promise<string> {
  const directory = join(stateDirectory, "worker-identity");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
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
  it("creates mode-0600 PKCS8 once and reloads the same signing identity", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const first = await loadOrCreateWorkerIdentity(stateDirectory);
    const directory = join(stateDirectory, "worker-identity");
    const privateKeyPath = join(directory, "private-key.pk8");

    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(privateKeyPath)).mode & 0o777).toBe(0o600);
    const privateKeyPkcs8 = await readFile(privateKeyPath);
    expect(InMemoryWorkerIdentity.fromPkcs8Der(privateKeyPkcs8).publicKeySpki)
      .toBe(first.publicKeySpki);

    const second = await loadOrCreateWorkerIdentity(stateDirectory);
    expect(second.publicKeySpki).toBe(first.publicKeySpki);
    const payload = workerSigningPayload(challenge);
    const publicKey = createPublicKey({
      key: Buffer.from(second.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    expect(verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      Buffer.from(second.signSessionChallenge(challenge, payload), "base64url"),
    )).toBe(true);
  });

  it("publishes one identity when creators race", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const identities = await Promise.all(
      Array.from({ length: 12 }, async () => loadOrCreateWorkerIdentity(stateDirectory)),
    );

    expect(new Set(identities.map(({ publicKeySpki }) => publicKeySpki))).toHaveLength(1);
    expect(await loadOrCreateWorkerIdentity(stateDirectory)).toHaveProperty(
      "publicKeySpki",
      identities[0]?.publicKeySpki,
    );
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

  it("rejects an identity owned by another effective user", async () => {
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
    expect((await lstat(join(stateDirectory, "worker-identity", "worker-id"))).mode & 0o777)
      .toBe(0o600);
    expect(await readFile(join(stateDirectory, "worker-identity", "worker-id"), "utf8"))
      .toBe(`${workerId}\n`);

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
