import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type GenerateKeyPairResult,
} from "jose";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  AccessTokenAuthenticationError,
  createOidcRemoteJwkSet,
  OidcAuthenticationError,
  OidcSessionService,
  RefreshTokenAuthenticationError,
  RefreshTokenReuseError,
  type OidcSessionConfig,
} from "../src/control-plane/oidc-session-service.js";
import type { AuthenticatedProjectApiKey } from "../src/control-plane/api-key-service.js";
import type {
  ControlPlaneDatabase,
  ControlPlaneQuery,
} from "../src/control-plane/project-scope.js";
import { resolveProjectScope } from "../src/control-plane/project-scope.js";
import {
  AuditAccessDeniedError,
  listProjectAuditEvents,
  recordAuditEvent,
} from "../src/control-plane/organization-authorization.js";
import {
  loadControlPlaneRuntimeConfig,
  PostgresControlPlaneDatabase,
} from "../src/server.js";

type Call = { statement: string; parameters: readonly unknown[] };
type ResponseStep = { rows: unknown[] } | ((call: Call) => { rows: unknown[] });

class IdentityDatabase implements ControlPlaneDatabase {
  readonly calls: Call[] = [];
  transactions = 0;
  private readonly responses: ResponseStep[];

  constructor(responses: ResponseStep[] = []) {
    this.responses = [...responses];
  }

  enqueue(...responses: ResponseStep[]): void {
    this.responses.push(...responses);
  }

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    return operation(this);
  }

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    const call = { statement, parameters };
    this.calls.push(call);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("Unexpected identity query.");
    const response = typeof next === "function" ? next(call) : next;
    return response as { rows: Row[] };
  }
}

const now = new Date("2026-09-01T12:00:00.000Z");

type Harness = {
  service: OidcSessionService;
  config: OidcSessionConfig;
  oidcKeys: GenerateKeyPairResult;
  accessKeys: GenerateKeyPairResult;
};

async function harness(
  database: IdentityDatabase,
  fetcher?: typeof fetch,
): Promise<Harness> {
  const oidcKeys = await generateKeyPair("EdDSA");
  const accessKeys = await generateKeyPair("EdDSA");
  const config: OidcSessionConfig = {
    issuer: "https://identity.example",
    authorizationEndpoint: "https://identity.example/authorize",
    tokenEndpoint: "https://identity.example/token",
    clientId: "diaoyan-web",
    redirectUri: "https://app.example/auth/callback",
    idTokenAlgorithms: ["EdDSA"],
    idTokenVerificationKey: oidcKeys.publicKey,
    accessTokenIssuer: "https://api.example",
    accessTokenAudience: "https://api.example/v1",
    accessTokenPrivateKey: accessKeys.privateKey,
    accessTokenPublicKey: accessKeys.publicKey,
  };
  return {
    service: new OidcSessionService(database, config, {
      ...(fetcher === undefined ? {} : { fetch: fetcher }),
      now: () => new Date(now),
    }),
    config,
    oidcKeys,
    accessKeys,
  };
}

function validRefreshToken(character = "A"): string {
  return `dya_rt_${character.repeat(43)}`;
}

async function runtimeKeyFiles(): Promise<Readonly<{
  directory: string;
  privateKeyPath: string;
  publicKeyPath: string;
}>> {
  const directory = await mkdtemp(join(tmpdir(), "diaoyan-control-plane-"));
  const keys = await generateKeyPair("EdDSA", { extractable: true });
  const privateKeyPath = join(directory, "worker-session-private.pem");
  const publicKeyPath = join(directory, "worker-session-public.pem");
  await writeFile(privateKeyPath, await exportPKCS8(keys.privateKey), { mode: 0o600 });
  await writeFile(publicKeyPath, await exportSPKI(keys.publicKey), { mode: 0o644 });
  return { directory, privateKeyPath, publicKeyPath };
}

function runtimeEnvironment(
  files: Readonly<{ privateKeyPath: string; publicKeyPath: string }>,
): NodeJS.ProcessEnv {
  return {
    DIAOYAN_CONTROL_DATABASE_URL: "postgresql://control:secret@database.example/diaoyan",
    DIAOYAN_WORKER_SESSION_ISSUER: "https://control.example",
    DIAOYAN_WORKER_SESSION_AUDIENCE: "https://control.example/v1/worker",
    DIAOYAN_WORKER_SESSION_PRIVATE_KEY_PATH: files.privateKeyPath,
    DIAOYAN_WORKER_SESSION_PUBLIC_KEY_PATH: files.publicKeyPath,
  };
}

describe("OIDC Authorization Code + PKCE", () => {
  it("stores only the state hash and creates an S256 authorization request", async () => {
    const database = new IdentityDatabase([{ rows: [{ id: "attempt-a" }] }]);
    const { service } = await harness(database);

    const started = await service.beginLogin();
    const url = new URL(started.authorizationUrl);
    const state = url.searchParams.get("state") as string;
    const nonce = url.searchParams.get("nonce") as string;
    const codeVerifier = database.calls[0]?.parameters[5] as string;

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(codeVerifier).digest("base64url"),
    );
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(database.calls[0]?.parameters[1]).toEqual(createHash("sha256").update(state).digest());
    expect(database.calls[0]?.parameters[6]).toBe(nonce);
    expect(JSON.stringify(database.calls[0]?.parameters)).not.toContain(state);
    expect(started.expiresAt.getTime() - now.getTime()).toBe(10 * 60 * 1_000);
  });

  it("consumes state once, verifies nonce, and provisions the personal tenant", async () => {
    const database = new IdentityDatabase([{ rows: [{ id: "attempt-a" }] }]);
    const tokenRequest = { form: undefined as URLSearchParams | undefined };
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      tokenRequest.form = init?.body as URLSearchParams;
      const nonce = database.calls[0]?.parameters[6] as string;
      const { oidcKeys, config } = await activeHarness;
      const issuedAt = Math.floor(now.getTime() / 1_000);
      const idToken = await new SignJWT({
        nonce,
        email: "person@example.com",
        name: "Example Person",
      })
        .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
        .setIssuer(config.issuer)
        .setAudience(config.clientId)
        .setSubject("provider-subject")
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .sign(oidcKeys.privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const activeHarness = await harness(database, fetcher);
    const started = await activeHarness.service.beginLogin();
    const authorizationUrl = new URL(started.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state") as string;
    const codeVerifier = database.calls[0]?.parameters[5] as string;
    const nonce = database.calls[0]?.parameters[6] as string;
    database.enqueue(
      { rows: [{
        issuer: activeHarness.config.issuer,
        client_id: activeHarness.config.clientId,
        redirect_uri: activeHarness.config.redirectUri,
        code_verifier: codeVerifier,
        nonce,
      }] },
      { rows: [{ id: "user-a", email: "person@example.com", display_name: "Example Person" }] },
      { rows: [{ id: "organization-a" }] },
      { rows: [{ id: "user-a" }] },
      { rows: [{ id: "project-a" }] },
      { rows: [{ id: "refresh-a" }] },
    );

    const completed = await activeHarness.service.completeLogin(state, "authorization-code");

    expect(tokenRequest.form?.get("grant_type")).toBe("authorization_code");
    expect(tokenRequest.form?.get("code_verifier")).toBe(codeVerifier);
    expect(tokenRequest.form?.get("code")).toBe("authorization-code");
    expect(completed.user).toEqual({
      id: "user-a",
      email: "person@example.com",
      displayName: "Example Person",
    });
    expect(completed.tokens.refreshToken).toMatch(/^dya_rt_[A-Za-z0-9_-]{43}$/u);
    expect(completed.tokens.accessTokenExpiresAt.getTime() - now.getTime()).toBe(10 * 60 * 1_000);
    expect(completed.tokens.refreshTokenExpiresAt.getTime() - now.getTime())
      .toBe(30 * 24 * 60 * 60 * 1_000);
    expect(database.calls[4]?.statement).toContain("organization_memberships");
    expect(database.calls[4]?.parameters).toHaveLength(2);
    expect(database.calls[5]?.statement).toContain("'default'");
    const refreshInsert = database.calls[6];
    expect(refreshInsert?.parameters[3]).toEqual(
      createHash("sha256").update(completed.tokens.refreshToken).digest(),
    );
    expect(JSON.stringify(database.calls)).not.toContain(completed.tokens.refreshToken);

    database.enqueue({ rows: [{ active: true }] });
    await expect(activeHarness.service.verifyAccessToken(completed.tokens.accessToken))
      .resolves.toEqual({ userId: "user-a" });
  });

  it("rejects replayed or expired state before contacting the token endpoint", async () => {
    const database = new IdentityDatabase([{ rows: [] }]);
    let fetchCalls = 0;
    const fetcher = (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as typeof fetch;
    const { service } = await harness(database, fetcher);

    await expect(service.completeLogin("A".repeat(43), "code"))
      .rejects.toEqual(new OidcAuthenticationError());
    expect(fetchCalls).toBe(0);
  });

  it("rejects an ID Token whose nonce does not match the consumed attempt", async () => {
    const database = new IdentityDatabase([{ rows: [{
      issuer: "https://identity.example",
      client_id: "diaoyan-web",
      redirect_uri: "https://app.example/auth/callback",
      code_verifier: "V".repeat(43),
      nonce: "expected-nonce",
    }] }]);
    let activeHarness: Harness;
    const fetcher = (async () => {
      const issuedAt = Math.floor(now.getTime() / 1_000);
      const idToken = await new SignJWT({ nonce: "wrong-nonce" })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(activeHarness.config.issuer)
        .setAudience(activeHarness.config.clientId)
        .setSubject("provider-subject")
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .sign(activeHarness.oidcKeys.privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    activeHarness = await harness(database, fetcher);

    await expect(activeHarness.service.completeLogin("A".repeat(43), "code"))
      .rejects.toEqual(new OidcAuthenticationError());
    expect(database.transactions).toBe(0);
  });

  it("requires a trusted HTTPS JWKS endpoint", () => {
    expect(() => createOidcRemoteJwkSet("http://identity.example/jwks"))
      .toThrow("jwksUri must use HTTPS");
  });
});

describe("Refresh Token Rotation", () => {
  it("uses a refresh token once and preserves the family expiration", async () => {
    const database = new IdentityDatabase([
      { rows: [{
        id: "refresh-a",
        family_id: "family-a",
        user_id: "user-a",
        expires_at: new Date("2026-09-30T12:00:00.000Z"),
        used_at: null,
        revoked_at: null,
      }] },
      { rows: [{ id: "refresh-a" }] },
      { rows: [{ id: "refresh-b" }] },
    ]);
    const { service } = await harness(database);
    const oldToken = validRefreshToken("A");

    const rotated = await service.rotateRefreshToken(oldToken);

    expect(rotated.refreshToken).toMatch(/^dya_rt_[A-Za-z0-9_-]{43}$/u);
    expect(rotated.refreshToken).not.toBe(oldToken);
    expect(rotated.refreshTokenExpiresAt).toEqual(new Date("2026-09-30T12:00:00.000Z"));
    expect(database.calls[0]?.statement).toContain("FOR UPDATE");
    expect(database.calls[0]?.parameters[0]).toEqual(createHash("sha256").update(oldToken).digest());
    expect(database.calls[2]?.parameters[1]).toBe("family-a");
    expect(database.calls[2]?.parameters[4]).toBe("refresh-a");
    expect(database.calls[2]?.parameters[3]).toEqual(
      createHash("sha256").update(rotated.refreshToken).digest(),
    );
  });

  it("commits all-session revocation before reporting token reuse", async () => {
    const database = new IdentityDatabase([
      { rows: [{
        id: "refresh-used",
        family_id: "family-a",
        user_id: "user-a",
        expires_at: new Date("2026-09-30T12:00:00.000Z"),
        used_at: new Date("2026-09-01T11:00:00.000Z"),
        revoked_at: null,
      }] },
      { rows: [{ id: "refresh-used" }, { id: "refresh-current" }] },
    ]);
    const { service } = await harness(database);

    await expect(service.rotateRefreshToken(validRefreshToken("B")))
      .rejects.toEqual(new RefreshTokenReuseError());
    expect(database.transactions).toBe(1);
    expect(database.calls[1]?.statement).toContain("WHERE user_id = $1");
    expect(database.calls[1]?.parameters).toEqual(["user-a"]);
  });

  it("uses one failure for malformed, unknown, expired, and revoked refresh tokens", async () => {
    const malformedDatabase = new IdentityDatabase();
    const malformed = await harness(malformedDatabase);
    await expect(malformed.service.rotateRefreshToken("bad-token"))
      .rejects.toEqual(new RefreshTokenAuthenticationError());
    expect(malformedDatabase.calls).toHaveLength(0);

    const unknownDatabase = new IdentityDatabase([{ rows: [] }]);
    const unknown = await harness(unknownDatabase);
    await expect(unknown.service.rotateRefreshToken(validRefreshToken("C")))
      .rejects.toEqual(new RefreshTokenAuthenticationError());
  });
});

describe("access-token revocation", () => {
  it("rejects a validly signed access token when its refresh family is inactive", async () => {
    const database = new IdentityDatabase([{ rows: [{ active: false }] }]);
    const activeHarness = await harness(database);
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const accessToken = await new SignJWT({ sid: "family-a" })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(activeHarness.config.accessTokenIssuer)
      .setAudience(activeHarness.config.accessTokenAudience)
      .setSubject("user-a")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 600)
      .setJti("access-a")
      .sign(activeHarness.accessKeys.privateKey);

    await expect(activeHarness.service.verifyAccessToken(accessToken))
      .rejects.toEqual(new AccessTokenAuthenticationError());
  });

  it("revokes every active refresh token for logout or security events", async () => {
    const database = new IdentityDatabase([{ rows: [{ id: "one" }, { id: "two" }] }]);
    const { service } = await harness(database);

    await expect(service.revokeAllUserSessions("user-a")).resolves.toBe(2);
    expect(database.calls[0]?.parameters).toEqual(["user-a"]);
    expect(database.calls[0]?.statement).toContain("revoked_at = COALESCE");
  });

  it("issues access tokens with fixed issuer, audience, algorithm, jti, and ten-minute expiry", async () => {
    const database = new IdentityDatabase([
      { rows: [{
        id: "refresh-a",
        family_id: "family-a",
        user_id: "user-a",
        expires_at: new Date("2026-09-30T12:00:00.000Z"),
        used_at: null,
        revoked_at: null,
      }] },
      { rows: [{ id: "refresh-a" }] },
      { rows: [{ id: "refresh-b" }] },
    ]);
    const activeHarness = await harness(database);
    const rotated = await activeHarness.service.rotateRefreshToken(validRefreshToken("D"));

    const verified = await jwtVerify(rotated.accessToken, activeHarness.accessKeys.publicKey, {
      algorithms: ["EdDSA"],
      issuer: activeHarness.config.accessTokenIssuer,
      audience: activeHarness.config.accessTokenAudience,
      typ: "JWT",
      currentDate: now,
    });
    expect(verified.payload.sub).toBe("user-a");
    expect(verified.payload.sid).toBe("family-a");
    expect(verified.payload.jti).toEqual(expect.any(String));
    expect((verified.payload.exp as number) - (verified.payload.iat as number)).toBe(600);
  });
});

describe("PostgreSQL control-plane adapter", () => {
  it("uses one checked-out client for a transaction and always releases it", async () => {
    const pool = new Pool({ allowExitOnIdle: true });
    const release = vi.fn();
    const clientQuery = vi.fn(async (statement: string, parameters?: unknown[]) => ({
      rows: statement === "SELECT value FROM sample WHERE id = $1"
        ? [{ value: parameters?.[0] }]
        : [],
    }));
    vi.spyOn(pool, "connect").mockResolvedValue({ query: clientQuery, release } as never);
    const database = new PostgresControlPlaneDatabase(pool);

    await expect(database.transaction(async (transaction) => {
      const result = await transaction.query<{ value: string }>(
        "SELECT value FROM sample WHERE id = $1",
        ["tenant-a"],
      );
      return result.rows[0]?.value;
    })).resolves.toBe("tenant-a");

    expect(clientQuery.mock.calls.map(([statement]) => statement))
      .toEqual(["BEGIN", "SELECT value FROM sample WHERE id = $1", "COMMIT"]);
    expect(clientQuery.mock.calls[1]?.[1]).toEqual(["tenant-a"]);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
    await database.close();
  });

  it("releases a successfully rolled-back transaction without discarding the client", async () => {
    const pool = new Pool({ allowExitOnIdle: true });
    const release = vi.fn();
    const operationError = new Error("operation failed");
    const clientQuery = vi.fn(async (_statement: string) => ({ rows: [] }));
    vi.spyOn(pool, "connect").mockResolvedValue({ query: clientQuery, release } as never);
    const database = new PostgresControlPlaneDatabase(pool);

    await expect(database.transaction(async () => {
      throw operationError;
    })).rejects.toBe(operationError);

    expect(clientQuery.mock.calls.map(([statement]) => statement)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
    await database.close();
  });

  it("preserves rollback errors and discards the failed connection", async () => {
    const pool = new Pool({ allowExitOnIdle: true });
    const release = vi.fn();
    const operationError = new Error("operation failed");
    const rollbackError = new Error("rollback failed");
    const clientQuery = vi.fn(async (statement: string) => {
      if (statement === "ROLLBACK") throw rollbackError;
      return { rows: [] };
    });
    vi.spyOn(pool, "connect").mockResolvedValue({ query: clientQuery, release } as never);
    const database = new PostgresControlPlaneDatabase(pool);

    const failure = await database.transaction(async () => {
      throw operationError;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([operationError, rollbackError]);
    expect(clientQuery.mock.calls.map(([statement]) => statement)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(rollbackError);
    await database.close();
  });
});

describe("control-plane runtime configuration", () => {
  it("enables verified TLS for remote PostgreSQL and keeps Worker keys out of environment values", async () => {
    const files = await runtimeKeyFiles();
    try {
      const config = await loadControlPlaneRuntimeConfig(runtimeEnvironment(files));

      expect(config.database).toMatchObject({
        connectionString: "postgresql://control:secret@database.example/diaoyan",
        max: 10,
        ssl: { rejectUnauthorized: true },
      });
      expect(config.identity.sessionTokenPrivateKey).toBeInstanceOf(CryptoKey);
      expect(config.identity.sessionTokenPublicKey).toBeInstanceOf(CryptoKey);
      expect(config.listener).toEqual({ host: "127.0.0.1", port: 8787, tls: null });
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  it("allows plaintext PostgreSQL only at an exact loopback address", async () => {
    const files = await runtimeKeyFiles();
    try {
      const environment = runtimeEnvironment(files);
      environment.DIAOYAN_CONTROL_DATABASE_URL = "postgresql://control@127.0.0.1/diaoyan";
      const config = await loadControlPlaneRuntimeConfig(environment);

      expect(config.database.ssl).toBe(false);
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  it("rejects connection-string SSL overrides", async () => {
    const files = await runtimeKeyFiles();
    try {
      const environment = runtimeEnvironment(files);
      environment.DIAOYAN_CONTROL_DATABASE_URL =
        "postgresql://control@database.example/diaoyan?sslmode=no-verify";

      await expect(loadControlPlaneRuntimeConfig(environment))
        .rejects.toThrow("must not contain sslmode");
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  it("rejects a Worker session private key readable by group or other users", async () => {
    const files = await runtimeKeyFiles();
    try {
      await chmod(files.privateKeyPath, 0o644);

      await expect(loadControlPlaneRuntimeConfig(runtimeEnvironment(files)))
        .rejects.toThrow("must not grant permissions to group or other users");
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });
});

describe("append-only Project audit", () => {
  it("records only bounded identity, target, outcome, and correlation fields", async () => {
    const database = new IdentityDatabase([{ rows: [{ id: "audit-a" }] }]);

    await recordAuditEvent(database, {
      organizationId: "organization-a",
      projectId: "project-a",
      actorType: "user",
      actorId: "user-a",
      action: "member.added",
      targetType: "organization_membership",
      targetId: "user-b",
      outcome: "succeeded",
      correlationId: "correlation-a",
    });

    expect(database.calls[0]?.statement).toContain("INSERT INTO audit_events");
    expect(database.calls[0]?.parameters.slice(1)).toEqual([
      "organization-a", "project-a", "user", "user-a", "member.added",
      "organization_membership", "user-b", "succeeded", "correlation-a",
    ]);
  });

  it("revalidates an owner or admin and applies a stable Project cursor", async () => {
    const scope = await resolveProjectScope(new IdentityDatabase([{ rows: [{
      project_id: "project-a",
      organization_id: "organization-a",
      role: "admin",
    }] }]), { userId: "user-a" }, "project-a");
    const occurredAt = new Date("2026-09-02T10:00:00.000Z");
    const database = new IdentityDatabase([
      { rows: [{ role: "admin" }] },
      { rows: [{
        id: "00000000-0000-4000-8000-000000000001",
        organization_id: "organization-a",
        project_id: "project-a",
        actor_type: "user",
        actor_id: "user-a",
        action: "project.created",
        target_type: "project",
        target_id: "project-a",
        outcome: "succeeded",
        correlation_id: "correlation-a",
        occurred_at: occurredAt,
      }] },
    ]);

    const events = await listProjectAuditEvents(database, scope, {
      limit: 25,
      before: { occurredAt, id: "00000000-0000-4000-8000-000000000002" },
    });

    expect(events[0]).toMatchObject({ projectId: "project-a", action: "project.created" });
    expect(database.calls[0]?.statement).toContain("FOR SHARE");
    expect(database.calls[1]?.parameters).toEqual([
      "project-a", "organization-a", occurredAt,
      "00000000-0000-4000-8000-000000000002", 25,
    ]);
  });

  it("fails explicitly when a member attempts to read audit events", async () => {
    const scope = await resolveProjectScope(new IdentityDatabase([{ rows: [{
      project_id: "project-a",
      organization_id: "organization-a",
      role: "member",
    }] }]), { userId: "user-a" }, "project-a");
    const database = new IdentityDatabase([{ rows: [] }]);

    await expect(listProjectAuditEvents(database, scope, { limit: 25, before: null }))
      .rejects.toEqual(new AuditAccessDeniedError());
    expect(database.calls).toHaveLength(1);
  });

  it("accepts an authenticated Project API Key without a user membership lookup", async () => {
    const apiKey: AuthenticatedProjectApiKey = Object.freeze({
      apiKeyId: "key-a",
      projectId: "project-a",
      organizationId: "organization-a",
      createdByUserId: "user-a",
      scopes: ["project:admin"] as const,
    });
    const database = new IdentityDatabase([{ rows: [] }]);

    await expect(listProjectAuditEvents(database, apiKey, { limit: 25, before: null }))
      .resolves.toEqual([]);
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.statement).toContain("FROM audit_events");
    expect(database.calls[0]?.parameters.slice(0, 2)).toEqual([
      "project-a", "organization-a",
    ]);
  });

  it("defines database guards for update, delete, and truncate", async () => {
    const migration = await readFile(
      new URL("../migrations/control-plane/0007_audit_events.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("BEFORE UPDATE OR DELETE ON audit_events");
    expect(migration).toContain("BEFORE TRUNCATE ON audit_events");
    expect(migration).toContain("FOREIGN KEY (project_id, organization_id)");
  });
});
