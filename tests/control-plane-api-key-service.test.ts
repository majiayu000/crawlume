import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";

import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  authenticateProjectApiKey,
  createProjectApiKey,
  ProjectApiKeyAuthenticationError,
  ProjectApiKeyNotFoundError,
  ProjectApiKeyScopeError,
  requireProjectApiKeyScope,
  revokeProjectApiKey,
  WorkerAuthenticationError,
  WorkerEnrollmentAuthenticationError,
  WorkerIdentityService,
  WorkerNotFoundError,
  WorkerPublicKeyError,
  type WorkerIdentityConfig,
  type ProjectApiKeyScope,
} from "../src/control-plane/api-key-service.js";
import {
  resolveProjectScope,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
  type ProjectScope,
} from "../src/control-plane/project-scope.js";

type Call = { statement: string; parameters: readonly unknown[] };
type Response = { rows: unknown[] } | ((call: Call) => { rows: unknown[] });

class ApiKeyDatabase implements ControlPlaneDatabase {
  readonly calls: Call[] = [];
  transactions = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly responses: Response[]) {}

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation(this);
    } finally {
      release();
    }
  }

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    const call = { statement, parameters };
    this.calls.push(call);
    const next = statement.includes("INSERT INTO audit_events")
      ? { rows: [{ id: "audit-event" }] } : this.responses.shift();
    if (next === undefined) throw new Error("Unexpected API key query.");
    const response = typeof next === "function" ? next(call) : next;
    return response as { rows: Row[] };
  }
}

async function projectScope(role: "owner" | "admin" | "member" = "admin"): Promise<ProjectScope> {
  return resolveProjectScope(
    new ApiKeyDatabase([{ rows: [{
      project_id: "project-a",
      organization_id: "organization-a",
      role,
    }] }]),
    { userId: "user-a" },
    "project-a",
  );
}

const createdAt = new Date("2026-09-01T12:00:00.000Z");
const auditContext = { correlationId: "correlation-a" };

function storedApiKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "key-a",
    project_id: "project-a",
    display_prefix: "dya_live_deadbeef",
    created_by_user_id: "user-a",
    tasks_write: true,
    results_read: false,
    project_admin: true,
    created_at: createdAt,
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function organizationAuthorization(role: "owner" | "admin" | "member"): Response[] {
  return [
    { rows: [{ id: "organization-a" }] },
    { rows: [{ role }] },
  ];
}

describe("Project API key creation", () => {
  it("returns the raw key once and stores only its hash and display prefix", async () => {
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    const database = new ApiKeyDatabase([
      ...organizationAuthorization("admin"),
      (call) => {
        const [id, projectId, displayPrefix, , createdByUserId] = call.parameters;
        return { rows: [storedApiKey({
          id,
          project_id: projectId,
          display_prefix: displayPrefix,
          created_by_user_id: createdByUserId,
          expires_at: expiresAt,
        })] };
      },
    ]);

    const created = await createProjectApiKey(database, await projectScope(), {
      scopes: ["project:admin", "tasks:write", "tasks:write"],
      expiresAt,
    }, auditContext);

    expect(created.rawKey).toMatch(/^dya_live_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/u);
    expect(created.rawKey.startsWith(`${created.apiKey.displayPrefix}_`)).toBe(true);
    expect(created.apiKey.scopes).toEqual(["tasks:write", "project:admin"]);
    const insertParameters = database.calls[2]?.parameters;
    expect(insertParameters?.[3]).toEqual(createHash("sha256").update(created.rawKey).digest());
    expect(JSON.stringify(database.calls)).not.toContain(created.rawKey);
    expect(insertParameters?.slice(5, 8)).toEqual([true, false, true]);
    expect(database.calls.at(-1)?.parameters.slice(3)).toEqual([
      "user", "user-a", "api_key.created", "api_key", created.apiKey.id,
      "succeeded", "correlation-a",
    ]);
  });

  it("rejects empty, unknown, and expired configuration before opening a transaction", async () => {
    const database = new ApiKeyDatabase([]);
    const scope = await projectScope();

    await expect(createProjectApiKey(database, scope, { scopes: [], expiresAt: null }, auditContext))
      .rejects.toThrow("At least one API key scope is required");
    await expect(createProjectApiKey(database, scope, {
      scopes: ["unknown" as ProjectApiKeyScope],
      expiresAt: null,
    }, auditContext)).rejects.toThrow("unsupported API key scope");
    await expect(createProjectApiKey(database, scope, {
      scopes: ["tasks:write"],
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    }, auditContext)).rejects.toThrow("valid future date");
    expect(database.transactions).toBe(0);
  });
});

describe("Project API key authentication", () => {
  const rawKey = `dya_live_deadbeef_${"A".repeat(43)}`;

  it("atomically checks active state, records use, and returns the bound Project", async () => {
    const database = new ApiKeyDatabase([{ rows: [{
      id: "key-a",
      project_id: "project-a",
      organization_id: "organization-a",
      created_by_user_id: "user-a",
      tasks_write: true,
      results_read: true,
      project_admin: false,
    }] }]);

    const identity = await authenticateProjectApiKey(database, rawKey, auditContext);

    expect(identity).toEqual({
      apiKeyId: "key-a",
      projectId: "project-a",
      organizationId: "organization-a",
      createdByUserId: "user-a",
      scopes: ["tasks:write", "results:read"],
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(database.calls[0]?.statement).toContain("revoked_at IS NULL");
    expect(database.calls[0]?.statement).toContain("expires_at > CURRENT_TIMESTAMP");
    expect(database.calls[0]?.parameters[0]).toEqual(
      createHash("sha256").update(rawKey).digest(),
    );
    expect(database.transactions).toBe(1);
    expect(database.calls.at(-1)?.parameters.slice(3, 8)).toEqual([
      "api_key", "key-a", "api_key.used", "api_key", "key-a",
    ]);
  });

  it("uses one indistinguishable failure for malformed, unknown, expired, and revoked keys", async () => {
    const malformedDatabase = new ApiKeyDatabase([]);
    await expect(authenticateProjectApiKey(malformedDatabase, "bad-key", auditContext))
      .rejects.toEqual(new ProjectApiKeyAuthenticationError());
    expect(malformedDatabase.calls).toHaveLength(0);

    const inactiveDatabase = new ApiKeyDatabase([{ rows: [] }]);
    await expect(authenticateProjectApiKey(inactiveDatabase, rawKey, auditContext))
      .rejects.toEqual(new ProjectApiKeyAuthenticationError());
  });

  it("enforces the fixed scope set", async () => {
    const identity = Object.freeze({
      apiKeyId: "key-a",
      projectId: "project-a",
      organizationId: "organization-a",
      createdByUserId: "user-a",
      scopes: ["tasks:write"] as const,
    });

    expect(() => requireProjectApiKeyScope(identity, "tasks:write")).not.toThrow();
    expect(() => requireProjectApiKeyScope(identity, "results:read"))
      .toThrow(ProjectApiKeyScopeError);
  });
});

describe("Project API key revocation", () => {
  it("revalidates an admin and binds revocation to the scoped Project", async () => {
    const revokedAt = new Date("2026-09-01T12:05:00.000Z");
    const database = new ApiKeyDatabase([
      ...organizationAuthorization("admin"),
      { rows: [storedApiKey({ revoked_at: revokedAt })] },
    ]);

    await expect(revokeProjectApiKey(database, await projectScope(), "key-a", auditContext))
      .resolves.toMatchObject({ id: "key-a", projectId: "project-a", revokedAt });
    expect(database.calls[2]?.parameters).toEqual(["key-a", "project-a"]);
  });

  it("does not reveal whether a key exists in another Project", async () => {
    const database = new ApiKeyDatabase([
      ...organizationAuthorization("owner"),
      { rows: [] },
    ]);

    await expect(revokeProjectApiKey(database, await projectScope("owner"), "key-b", auditContext))
      .rejects.toEqual(new ProjectApiKeyNotFoundError());
    expect(database.calls[2]?.parameters).toEqual(["key-b", "project-a"]);
  });
});

const workerNow = new Date("2026-09-01T13:00:00.000Z");

async function workerHarness(database: ApiKeyDatabase): Promise<{
  service: WorkerIdentityService;
  config: WorkerIdentityConfig;
  tokenPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  tokenPublicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
}> {
  const tokenKeys = await generateKeyPair("EdDSA");
  const config: WorkerIdentityConfig = {
    sessionTokenIssuer: "https://api.example",
    sessionTokenAudience: "https://api.example/v1/workers",
    sessionTokenPrivateKey: tokenKeys.privateKey,
    sessionTokenPublicKey: tokenKeys.publicKey,
  };
  return {
    service: new WorkerIdentityService(database, config, { now: () => new Date(workerNow) }),
    config,
    tokenPrivateKey: tokenKeys.privateKey,
    tokenPublicKey: tokenKeys.publicKey,
  };
}

function workerKeyPair(): {
  privateKey: KeyObject;
  publicKeySpki: string;
  publicKeyDer: Buffer;
} {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyDer = keys.publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: keys.privateKey,
    publicKeySpki: publicKeyDer.toString("base64url"),
    publicKeyDer,
  };
}

function storedWorker(capabilityHash: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    id: "worker-a",
    project_id: "project-a",
    name: "private-mac",
    kind: "private",
    version: "1.0.0",
    capability_hash: capabilityHash,
    status: "active",
    created_by_user_id: "user-a",
    created_at: workerNow,
    disabled_at: null,
    ...overrides,
  };
}

function workerChallengeProof(character = "D") {
  const keys = workerKeyPair();
  const challenge = `dya_wc_${character.repeat(43)}`;
  const capabilityHash = createHash("sha256").update("capabilities").digest();
  const signature = signMessage(
    null,
    Buffer.from(`dya-worker-session-v1\n${challenge}`),
    keys.privateKey,
  ).toString("base64url");
  return {
    challenge,
    signature,
    capabilityHash,
    identity: {
      worker_id: "worker-a",
      project_id: "project-a",
      public_key_id: "key-a",
      public_key_spki: keys.publicKeyDer,
      capability_hash: capabilityHash,
    },
  };
}

describe("Worker enrollment", () => {
  it("lets an admin create a ten-minute Project-bound token and stores only its hash", async () => {
    const database = new ApiKeyDatabase([
      ...organizationAuthorization("admin"),
      (call) => ({ rows: [{
        id: "enrollment-a",
        project_id: call.parameters[1],
        worker_name: call.parameters[2],
        created_by_user_id: call.parameters[4],
      }] }),
    ]);
    const { service } = await workerHarness(database);
    const created = await service.createEnrollment(await projectScope(), {
      workerName: " private-mac ",
    }, auditContext);

    expect(created.rawToken).toMatch(/^dya_we_[A-Za-z0-9_-]{43}$/u);
    expect(created.enrollment).toMatchObject({
      id: "enrollment-a",
      projectId: "project-a",
      workerName: "private-mac",
      createdByUserId: "user-a",
    });
    expect(created.enrollment.expiresAt.getTime() - workerNow.getTime()).toBe(10 * 60 * 1_000);
    expect(database.calls[2]?.parameters[3]).toEqual(
      createHash("sha256").update(created.rawToken).digest(),
    );
    expect(JSON.stringify(database.calls)).not.toContain(created.rawToken);
    expect(database.calls.at(-1)?.parameters[5]).toBe("worker.enrollment_created");
  });

  it("rejects member enrollment creation before inserting a token", async () => {
    const database = new ApiKeyDatabase(organizationAuthorization("member"));
    const { service } = await workerHarness(database);

    await expect(service.createEnrollment(
      await projectScope("member"), { workerName: "worker" }, auditContext,
    ))
      .rejects.toMatchObject({ code: "ORGANIZATION_ACCESS_DENIED" });
    expect(database.calls).toHaveLength(2);
  });

  it("consumes the token once and derives Project ownership only from the enrollment", async () => {
    const rawToken = `dya_we_${"A".repeat(43)}`;
    const keys = workerKeyPair();
    const capabilities = { browser: true, formats: ["html"] };
    const capabilityHash = createHash("sha256").update(JSON.stringify(capabilities)).digest();
    const database = new ApiKeyDatabase([
      { rows: [{
        id: "enrollment-a",
        project_id: "project-a",
        organization_id: "organization-a",
        worker_name: "private-mac",
        created_by_user_id: "user-a",
      }] },
      (call) => ({ rows: [storedWorker(call.parameters[5] as Buffer, {
        id: call.parameters[0],
        project_id: call.parameters[1],
        name: call.parameters[2],
        version: call.parameters[3],
        created_by_user_id: call.parameters[6],
      })] }),
      { rows: [{ id: "key-a" }] },
    ]);
    const { service } = await workerHarness(database);
    const worker = await service.enroll(rawToken, {
      publicKeySpki: keys.publicKeySpki,
      version: "1.0.0",
      capabilities,
    }, auditContext);

    expect(worker).toMatchObject({ projectId: "project-a", name: "private-mac" });
    expect(worker.capabilityHash).toBe(capabilityHash.toString("base64url"));
    expect(database.calls[0]?.parameters[0]).toEqual(
      createHash("sha256").update(rawToken).digest(),
    );
    expect(database.calls[1]?.parameters[1]).toBe("project-a");
    expect(database.calls[2]?.parameters[1]).toBe("project-a");
    expect(database.calls[2]?.parameters[3]).toEqual(keys.publicKeyDer);
    expect(JSON.stringify(database.calls)).not.toContain(rawToken);
    expect(database.calls.at(-1)?.parameters.slice(3, 8)).toEqual([
      "user", "user-a", "worker.enrolled", "worker", worker.id,
    ]);
  });

  it("uses one error for malformed, unknown, expired, and replayed enrollment tokens", async () => {
    const malformedDatabase = new ApiKeyDatabase([]);
    const malformed = await workerHarness(malformedDatabase);
    await expect(malformed.service.enroll("bad", {
      publicKeySpki: workerKeyPair().publicKeySpki,
      version: "1.0.0",
      capabilities: {},
    }, auditContext)).rejects.toEqual(new WorkerEnrollmentAuthenticationError());
    expect(malformedDatabase.calls).toHaveLength(0);

    const inactiveDatabase = new ApiKeyDatabase([{ rows: [] }]);
    const inactive = await workerHarness(inactiveDatabase);
    await expect(inactive.service.enroll(`dya_we_${"B".repeat(43)}`, {
      publicKeySpki: workerKeyPair().publicKeySpki,
      version: "1.0.0",
      capabilities: {},
    }, auditContext)).rejects.toEqual(new WorkerEnrollmentAuthenticationError());
  });

  it("accepts only an Ed25519 public key and has no private-key input", async () => {
    const database = new ApiKeyDatabase([]);
    const { service } = await workerHarness(database);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ format: "der", type: "spki" }).toString("base64url");

    await expect(service.enroll(`dya_we_${"C".repeat(43)}`, {
      publicKeySpki: rsa,
      version: "1.0.0",
      capabilities: {},
    }, auditContext)).rejects.toEqual(new WorkerPublicKeyError());
    expect(database.calls).toHaveLength(0);
  });
});

describe("Worker challenge and session", () => {
  it("stores only a two-minute challenge hash and does not accept a Project from the Worker", async () => {
    const database = new ApiKeyDatabase([{ rows: [{ id: "challenge-a" }] }]);
    const { service } = await workerHarness(database);
    const challenge = await service.createChallenge("worker-a");

    expect(challenge.challenge).toMatch(/^dya_wc_[A-Za-z0-9_-]{43}$/u);
    expect(challenge.signingPayload).toBe(`dya-worker-session-v1\n${challenge.challenge}`);
    expect(challenge.expiresAt.getTime() - workerNow.getTime()).toBe(2 * 60 * 1_000);
    expect(database.calls[0]?.parameters[1]).toBe("worker-a");
    expect(database.calls[0]?.parameters[2]).toEqual(
      createHash("sha256").update(challenge.challenge).digest(),
    );
    expect(JSON.stringify(database.calls)).not.toContain(challenge.challenge);
  });

  it("uses one error for an unknown, expired, or replayed challenge", async () => {
    const database = new ApiKeyDatabase([{ rows: [] }]);
    const { service } = await workerHarness(database);

    await expect(service.createSession({
      workerId: "worker-a",
      challenge: `dya_wc_${"F".repeat(43)}`,
      signature: Buffer.alloc(64).toString("base64url"),
    })).rejects.toEqual(new WorkerAuthenticationError());
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.statement).toContain("consumed_at IS NULL");
  });

  it("verifies the Ed25519 proof and issues a five-minute Project-bound session", async () => {
    const { challenge, signature, capabilityHash, identity } = workerChallengeProof();
    const database = new ApiKeyDatabase([
      { rows: [identity] },
      { rows: [{ id: "session-a" }] },
      { rows: [{ active: true }] },
    ]);
    const active = await workerHarness(database);
    const session = await active.service.createSession({
      workerId: "worker-a",
      challenge,
      signature,
    });

    expect(session.expiresAt.getTime() - workerNow.getTime()).toBe(5 * 60 * 1_000);
    const verifiedJwt = await jwtVerify(session.token, active.tokenPublicKey, {
      algorithms: ["EdDSA"],
      issuer: active.config.sessionTokenIssuer,
      audience: active.config.sessionTokenAudience,
      typ: "worker+jwt",
      currentDate: workerNow,
    });
    expect(verifiedJwt.payload.sub).toBe("worker-a");
    expect(verifiedJwt.payload.project_id).toBe("project-a");
    expect(verifiedJwt.payload.capability_hash).toBe(capabilityHash.toString("base64url"));
    expect((verifiedJwt.payload.exp as number) - (verifiedJwt.payload.iat as number)).toBe(300);
    expect(database.calls[0]?.statement).toContain("FOR UPDATE OF challenges");
    expect(database.calls[1]?.statement).toContain("WITH consumed AS");

    await expect(active.service.verifySession(session.token)).resolves.toEqual({
      workerId: "worker-a",
      projectId: "project-a",
      capabilityHash: capabilityHash.toString("base64url"),
      sessionId: verifiedJwt.payload.jti,
    });
    expect(database.calls[2]?.parameters.slice(1, 3)).toEqual(["worker-a", "project-a"]);
  });

  it("does not consume a challenge when the signature is invalid", async () => {
    const proof = workerChallengeProof("E");
    const database = new ApiKeyDatabase([
      { rows: [proof.identity] },
      { rows: [proof.identity] },
      { rows: [{ id: "session-a" }] },
    ]);
    const { service } = await workerHarness(database);

    await expect(service.createSession({
      workerId: "worker-a",
      challenge: proof.challenge,
      signature: Buffer.alloc(64).toString("base64url"),
    })).rejects.toEqual(new WorkerAuthenticationError());
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.statement).toContain("FOR UPDATE OF challenges");
    expect(database.calls[0]?.statement).not.toContain("SET consumed_at");

    await expect(service.createSession({
      workerId: "worker-a",
      challenge: proof.challenge,
      signature: proof.signature,
    })).resolves.toMatchObject({ expiresAt: new Date(workerNow.getTime() + 5 * 60 * 1_000) });
    expect(database.calls[2]?.statement).toContain("WITH consumed AS");
  });

  it("allows only one concurrent session exchange for a challenge", async () => {
    const proof = workerChallengeProof("G");
    const database = new ApiKeyDatabase([
      { rows: [proof.identity] },
      { rows: [{ id: "session-a" }] },
      { rows: [] },
    ]);
    const { service } = await workerHarness(database);
    const exchanges = await Promise.allSettled([
      service.createSession({
        workerId: "worker-a", challenge: proof.challenge, signature: proof.signature,
      }),
      service.createSession({
        workerId: "worker-a", challenge: proof.challenge, signature: proof.signature,
      }),
    ]);

    expect(exchanges.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = exchanges.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: new WorkerAuthenticationError() });
    expect(database.calls.filter(({ statement }) => statement.includes("INSERT INTO worker_sessions")))
      .toHaveLength(1);
  });

  it("can retry a challenge after a database failure rolls back its exchange", async () => {
    const proof = workerChallengeProof("H");
    const databaseFailure = new Error("database unavailable");
    const database = new ApiKeyDatabase([
      { rows: [proof.identity] },
      () => { throw databaseFailure; },
      { rows: [proof.identity] },
      { rows: [{ id: "session-a" }] },
    ]);
    const { service } = await workerHarness(database);

    await expect(service.createSession({
      workerId: "worker-a", challenge: proof.challenge, signature: proof.signature,
    })).rejects.toBe(databaseFailure);
    await expect(service.createSession({
      workerId: "worker-a", challenge: proof.challenge, signature: proof.signature,
    })).resolves.toMatchObject({ expiresAt: new Date(workerNow.getTime() + 5 * 60 * 1_000) });
    expect(database.transactions).toBe(2);
  });

  it("rejects a valid JWT when its database session or Worker is inactive", async () => {
    const database = new ApiKeyDatabase([{ rows: [{ active: false }] }]);
    const active = await workerHarness(database);
    const issuedAt = Math.floor(workerNow.getTime() / 1_000);
    const token = await new SignJWT({
      project_id: "project-a",
      capability_hash: createHash("sha256").update("capabilities").digest("base64url"),
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "worker+jwt" })
      .setIssuer(active.config.sessionTokenIssuer)
      .setAudience(active.config.sessionTokenAudience)
      .setSubject("worker-a")
      .setJti("session-a")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(active.tokenPrivateKey);

    await expect(active.service.verifySession(token)).rejects.toEqual(
      new WorkerAuthenticationError(),
    );
  });
});

describe("Worker disable", () => {
  it("binds disablement to Project and revokes the key and every active session", async () => {
    const capabilityHash = createHash("sha256").update("capabilities").digest();
    const database = new ApiKeyDatabase([
      ...organizationAuthorization("admin"),
      { rows: [storedWorker(capabilityHash, {
        status: "disabled",
        disabled_at: workerNow,
      })] },
      { rows: [{ id: "key-a" }] },
      { rows: [{ id: "session-a" }] },
    ]);
    const { service } = await workerHarness(database);
    const disabled = await service.disableWorker(await projectScope(), "worker-a", auditContext);

    expect(disabled).toMatchObject({
      id: "worker-a",
      projectId: "project-a",
      status: "disabled",
      disabledAt: workerNow,
    });
    expect(database.calls[2]?.parameters.slice(0, 2)).toEqual(["worker-a", "project-a"]);
    expect(database.calls[3]?.parameters.slice(0, 2)).toEqual(["worker-a", "project-a"]);
    expect(database.calls[4]?.parameters.slice(0, 2)).toEqual(["worker-a", "project-a"]);
    expect(database.calls.at(-1)?.parameters[5]).toBe("worker.disabled");
  });

  it("does not reveal whether a Worker exists in another Project", async () => {
    const database = new ApiKeyDatabase([
      ...organizationAuthorization("owner"),
      { rows: [] },
    ]);
    const { service } = await workerHarness(database);

    await expect(service.disableWorker(await projectScope("owner"), "worker-b", auditContext))
      .rejects.toEqual(new WorkerNotFoundError());
    expect(database.calls[2]?.parameters.slice(0, 2)).toEqual(["worker-b", "project-a"]);
  });
});
