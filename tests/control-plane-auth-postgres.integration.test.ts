import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";

import { generateKeyPair, type GenerateKeyPairResult } from "jose";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  WorkerAuthenticationError,
  WorkerChallengeRateLimitedError,
  WorkerEnrollmentAuthenticationError,
  WorkerIdentityService,
  type WorkerIdentityConfig,
} from "../src/control-plane/api-key-service.js";
import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";
import {
  OidcSessionService,
  AccessTokenAuthenticationError,
  RefreshTokenAuthenticationError,
  OidcLoginRateLimitedError,
  RefreshTokenRotationConflictError,
  RefreshTokenReuseError,
  type OidcSessionConfig,
} from "../src/control-plane/oidc-session-service.js";
import {
  resolveProjectScope,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
  type ProjectScope,
} from "../src/control-plane/project-scope.js";
import { PostgresControlPlaneDatabase } from "../src/server.js";
import { trackPoolErrors } from "./helpers.js";

const configuredDatabaseUrl = process.env.DIAOYAN_TEST_POSTGRES_URL;
const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;
const userId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000101";
const projectId = "00000000-0000-4000-8000-000000000201";
const auditContext = { correlationId: "auth-postgres-integration" };

function requiredDatabaseUrl(): string {
  if (configuredDatabaseUrl === undefined) {
    throw new Error(
      "DIAOYAN_TEST_POSTGRES_URL is required. Run the dedicated `pnpm test:postgres` Gate.",
    );
  }
  return configuredDatabaseUrl;
}

function quotedTestDatabase(name: string): string {
  if (!/^diaoyan_auth_test_[0-9a-f]{32}$/u.test(name)) {
    throw new Error(`Refusing to use an unexpected PostgreSQL test database name: ${name}`);
  }
  return `"${name}"`;
}

function databaseUrl(name: string): string {
  const url = new URL(requiredDatabaseUrl());
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DIAOYAN_TEST_POSTGRES_URL must use postgres or postgresql.");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

type Deferred<Value> = Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}>;

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type QueryGate = Readonly<{
  matches(statement: string): boolean;
  entered: Deferred<void>;
  release: Deferred<void>;
}>;

class ObservedPostgresDatabase implements ControlPlaneDatabase {
  readonly transactionStarted = deferred<number>();
  private readonly database: PostgresControlPlaneDatabase;
  private gate: QueryGate | undefined;

  constructor(pool: Pool) {
    this.database = new PostgresControlPlaneDatabase(pool);
  }

  holdAfterQuery(matches: (statement: string) => boolean): QueryGate {
    if (this.gate !== undefined) throw new Error("Only one query gate may be active.");
    const gate = { matches, entered: deferred<void>(), release: deferred<void>() };
    this.gate = gate;
    return gate;
  }

  query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    return this.database.query(statement, parameters);
  }

  transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction(async (transaction) => {
      const backend = await transaction.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", []);
      const pid = backend.rows[0]?.pid;
      if (pid === undefined) throw new Error("PostgreSQL did not return a backend PID.");
      this.transactionStarted.resolve(pid);
      let gateUsed = false;
      const observed: ControlPlaneQuery = {
        query: async <Row>(statement: string, parameters: readonly unknown[]) => {
          const result = await transaction.query<Row>(statement, parameters);
          if (!gateUsed && this.gate?.matches(statement) === true) {
            gateUsed = true;
            this.gate.entered.resolve();
            await this.gate.release.promise;
          }
          return result;
        },
      };
      return operation(observed);
    });
  }
}

type WorkerKeys = Readonly<{
  privateKey: KeyObject;
  publicKeySpki: string;
}>;

function workerKeys(): WorkerKeys {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKey: keys.privateKey,
    publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

function signChallenge(challenge: string, privateKey: KeyObject): string {
  return signMessage(
    null,
    Buffer.from(`dya-worker-session-v1\n${challenge}`),
    privateKey,
  ).toString("base64url");
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function refreshToken(character: string): string {
  return `dya_rt_${character.repeat(43)}`;
}

function outcome<Value>(promise: Promise<Value>): Promise<
  | Readonly<{ status: "fulfilled"; value: Value }>
  | Readonly<{ status: "rejected"; reason: unknown }>
> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

describeWithPostgres("control-plane authentication on PostgreSQL", () => {
  let administration: Pool;
  let databaseName: string | undefined;
  let fixturePool: Pool | undefined;
  const unexpectedPoolErrors: unknown[] = [];
  let fixtureDatabase: PostgresControlPlaneDatabase;
  let scope: ProjectScope;
  let workerTokenKeys: GenerateKeyPairResult;
  let workerConfig: WorkerIdentityConfig;
  let oidcKeys: GenerateKeyPairResult;
  let accessKeys: GenerateKeyPairResult;
  let oidcConfig: OidcSessionConfig;
  let now: Date;
  const auxiliaryPools: Pool[] = [];

  beforeAll(async () => {
    administration = new Pool({ connectionString: requiredDatabaseUrl(), max: 1 });
    await administration.query("SELECT 1");
    workerTokenKeys = await generateKeyPair("EdDSA");
    oidcKeys = await generateKeyPair("EdDSA");
    accessKeys = await generateKeyPair("EdDSA");
    workerConfig = {
      sessionTokenIssuer: "https://api.example",
      sessionTokenAudience: "https://api.example/v1/workers",
      sessionTokenPrivateKey: workerTokenKeys.privateKey,
      sessionTokenPublicKey: workerTokenKeys.publicKey,
    };
    oidcConfig = {
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
  });

  beforeEach(async () => {
    now = new Date();
    databaseName = `diaoyan_auth_test_${randomUUID().replaceAll("-", "")}`;
    await administration.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
    fixturePool = trackPoolErrors(
      new Pool({ connectionString: databaseUrl(databaseName), max: 2 }),
      unexpectedPoolErrors,
    );
    fixtureDatabase = new PostgresControlPlaneDatabase(fixturePool);
    await runControlPlaneMigrations(fixtureDatabase);
    await fixtureDatabase.query(`
      INSERT INTO users(id, oidc_issuer, oidc_subject)
      VALUES ($1, 'https://identity.example', 'auth-postgres-user')
    `, [userId]);
    await fixtureDatabase.query(`
      INSERT INTO organizations(id, slug, name, kind)
      VALUES ($1, 'auth-postgres', 'Auth PostgreSQL', 'business')
    `, [organizationId]);
    await fixtureDatabase.query(`
      INSERT INTO organization_memberships(organization_id, user_id, role)
      VALUES ($1, $2, 'owner')
    `, [organizationId, userId]);
    await fixtureDatabase.query(`
      INSERT INTO projects(id, organization_id, slug, name)
      VALUES ($1, $2, 'default', 'Default')
    `, [projectId, organizationId]);
    scope = await resolveProjectScope(fixtureDatabase, { userId }, projectId);
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    const pools = auxiliaryPools.splice(0);
    if (fixturePool !== undefined) pools.push(fixturePool);
    fixturePool = undefined;
    for (const pool of pools) {
      try {
        await pool.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (databaseName !== undefined) {
      try {
        await administration.query(`DROP DATABASE ${quotedTestDatabase(databaseName)} WITH (FORCE)`);
      } catch (error) {
        cleanupErrors.push(error);
      }
      databaseName = undefined;
    }
    cleanupErrors.push(...unexpectedPoolErrors.splice(0));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "PostgreSQL auth test cleanup failed.");
    }
  });

  afterAll(async () => {
    await administration.end();
  });

  function observedDatabase(): ObservedPostgresDatabase {
    if (databaseName === undefined) throw new Error("The test database has not been created.");
    const pool = trackPoolErrors(
      new Pool({ connectionString: databaseUrl(databaseName), max: 1 }),
      unexpectedPoolErrors,
    );
    auxiliaryPools.push(pool);
    return new ObservedPostgresDatabase(pool);
  }

  async function waitForLock(pid: number): Promise<string> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const activity = await administration.query<{ wait_event_type: string | null }>(`
        SELECT wait_event_type
        FROM pg_stat_activity
        WHERE pid = $1
      `, [pid]);
      const waitEventType = activity.rows[0]?.wait_event_type;
      if (waitEventType === "Lock") return waitEventType;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`PostgreSQL backend ${pid} did not reach a lock wait.`);
  }

  function workerService(
    database: ControlPlaneDatabase,
    config: WorkerIdentityConfig = workerConfig,
  ): WorkerIdentityService {
    return new WorkerIdentityService(database, config, { now: () => new Date(now) });
  }

  async function createEnrollment(): Promise<Readonly<{ rawToken: string }>> {
    return workerService(fixtureDatabase).createEnrollment(
      scope,
      { workerName: `private-${randomUUID()}` },
      auditContext,
    );
  }

  async function enrollWorker(): Promise<Readonly<{ workerId: string; keys: WorkerKeys }>> {
    const enrollment = await createEnrollment();
    const keys = workerKeys();
    const worker = await workerService(fixtureDatabase).enroll(enrollment.rawToken, {
      publicKeySpki: keys.publicKeySpki,
      version: "1.0.0",
      capabilities: { http: true },
    }, auditContext);
    return { workerId: worker.id, keys };
  }

  it("bounds concurrent OIDC login starts to one database-clock attempt per client", async () => {
    const firstDatabase = observedDatabase();
    const secondDatabase = observedDatabase();
    const gate = firstDatabase.holdAfterQuery((statement) =>
      statement.includes("pg_try_advisory_xact_lock"));

    const first = oidcService(firstDatabase).beginLogin();
    await gate.entered.promise;
    let secondResult;
    try {
      secondResult = await outcome(oidcService(secondDatabase).beginLogin());
    } finally {
      gate.release.resolve();
    }

    await expect(first).resolves.toMatchObject({ expiresAt: expect.any(Date) });
    expect(secondResult).toEqual({
      status: "rejected",
      reason: new OidcLoginRateLimitedError(),
    });
    await expect(oidcService(fixtureDatabase).beginLogin()).rejects.toEqual(
      new OidcLoginRateLimitedError(),
    );
    const attempts = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM oidc_login_attempts
    `, []);
    expect(attempts.rows[0]?.count).toBe("1");
  });

  it("cleans expired and old consumed OIDC attempts before admitting the next start", async () => {
    await oidcService(fixtureDatabase).beginLogin();
    await fixtureDatabase.query(`
      UPDATE oidc_login_attempts
      SET created_at = clock_timestamp() - INTERVAL '2 minutes',
        expires_at = clock_timestamp() + INTERVAL '8 minutes',
        consumed_at = clock_timestamp() - INTERVAL '2 seconds'
    `, []);

    await expect(oidcService(fixtureDatabase).beginLogin()).resolves.toBeDefined();
    let attempts = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM oidc_login_attempts
    `, []);
    expect(attempts.rows[0]?.count).toBe("1");

    await fixtureDatabase.query(`
      UPDATE oidc_login_attempts
      SET created_at = clock_timestamp() - INTERVAL '11 minutes',
        expires_at = clock_timestamp() - INTERVAL '1 minute',
        consumed_at = NULL
    `, []);
    await expect(oidcService(fixtureDatabase).beginLogin()).resolves.toBeDefined();
    attempts = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM oidc_login_attempts
    `, []);
    expect(attempts.rows[0]?.count).toBe("1");
  });

  it("isolates OIDC begin budgets by issuer and client identity", async () => {
    const first = await oidcService(fixtureDatabase).beginLogin();
    const otherClient = new OidcSessionService(fixtureDatabase, {
      ...oidcConfig,
      clientId: "diaoyan-other-client",
    }, { now: () => new Date(now) });
    const second = await otherClient.beginLogin();
    const otherIssuer = new OidcSessionService(fixtureDatabase, {
      ...oidcConfig,
      issuer: "https://other-issuer.example",
    }, { now: () => new Date(now) });
    const third = await otherIssuer.beginLogin();

    expect(first.authorizationUrl).toContain("client_id=diaoyan-web");
    expect(second.authorizationUrl).toContain("client_id=diaoyan-other-client");
    expect(third.authorizationUrl).toContain("client_id=diaoyan-web");
    const attempts = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM oidc_login_attempts
    `, []);
    expect(attempts.rows[0]?.count).toBe("3");
  });

  function oidcService(
    database: ControlPlaneDatabase,
    decisionTime = now,
  ): OidcSessionService {
    return new OidcSessionService(database, oidcConfig, {
      now: () => new Date(decisionTime),
    });
  }

  async function insertRefresh(input: Readonly<{
    rawToken: string;
    familyId: string;
    previousTokenId?: string;
    usedAt?: Date;
  }>): Promise<string> {
    const id = randomUUID();
    await fixtureDatabase.query(`
      INSERT INTO refresh_tokens(
        id, family_id, user_id, token_hash, previous_token_id,
        created_at, expires_at, used_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      id,
      input.familyId,
      userId,
      hashToken(input.rawToken),
      input.previousTokenId ?? null,
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() + 86_400_000),
      input.usedAt ?? null,
    ]);
    return id;
  }

  it("allows only one backend to consume an enrollment token", async () => {
    const enrollment = await createEnrollment();
    const keys = workerKeys();
    const firstDatabase = observedDatabase();
    const secondDatabase = observedDatabase();
    const gate = firstDatabase.holdAfterQuery((statement) =>
      statement.includes("UPDATE worker_enrollments AS enrollment"));
    const input = {
      publicKeySpki: keys.publicKeySpki,
      version: "1.0.0",
      capabilities: { http: true },
    };

    const first = workerService(firstDatabase).enroll(enrollment.rawToken, input, auditContext);
    await gate.entered.promise;
    const second = outcome(
      workerService(secondDatabase).enroll(enrollment.rawToken, input, auditContext),
    );
    const firstPid = await firstDatabase.transactionStarted.promise;
    const secondPid = await secondDatabase.transactionStarted.promise;
    expect(firstPid).not.toBe(secondPid);
    await expect(waitForLock(secondPid)).resolves.toBe("Lock");
    gate.release.resolve();

    await expect(first).resolves.toMatchObject({ projectId, status: "active" });
    const secondResult = await second;
    expect(secondResult).toEqual({
      status: "rejected",
      reason: new WorkerEnrollmentAuthenticationError(),
    });
    const state = await fixtureDatabase.query<{ workers: string; consumed: boolean }>(`
      SELECT
        (SELECT count(*) FROM workers)::text AS workers,
        consumed_at IS NOT NULL AS consumed
      FROM worker_enrollments
      WHERE token_hash = $1
    `, [hashToken(enrollment.rawToken)]);
    expect(state.rows[0]).toEqual({ workers: "1", consumed: true });
  });

  it("rolls back enrollment consumption when Worker creation fails and permits retry", async () => {
    const enrollment = await createEnrollment();
    const keys = workerKeys();
    await fixtureDatabase.query(`
      CREATE FUNCTION fail_worker_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected worker insert failure';
      END;
      $$
    `, []);
    await fixtureDatabase.query(`
      CREATE TRIGGER fail_worker_insert
      BEFORE INSERT ON workers
      FOR EACH ROW EXECUTE FUNCTION fail_worker_insert()
    `, []);

    await expect(workerService(fixtureDatabase).enroll(enrollment.rawToken, {
      publicKeySpki: keys.publicKeySpki,
      version: "1.0.0",
      capabilities: { http: true },
    }, auditContext)).rejects.toThrow("injected worker insert failure");
    const rolledBack = await fixtureDatabase.query<{ consumed_at: Date | null }>(`
      SELECT consumed_at FROM worker_enrollments WHERE token_hash = $1
    `, [hashToken(enrollment.rawToken)]);
    expect(rolledBack.rows[0]?.consumed_at).toBeNull();

    await fixtureDatabase.query("DROP TRIGGER fail_worker_insert ON workers", []);
    await fixtureDatabase.query("DROP FUNCTION fail_worker_insert()", []);
    await expect(workerService(fixtureDatabase).enroll(enrollment.rawToken, {
      publicKeySpki: keys.publicKeySpki,
      version: "1.0.0",
      capabilities: { http: true },
    }, auditContext)).resolves.toMatchObject({ projectId, status: "active" });
  });

  it("does not consume a challenge with a bad signature and accepts the valid proof", async () => {
    const worker = await enrollWorker();
    const service = workerService(fixtureDatabase);
    const challenge = await service.createChallenge(worker.workerId);
    const badSignature = signChallenge(challenge.challenge, workerKeys().privateKey);

    await expect(service.createSession({
      workerId: worker.workerId,
      challenge: challenge.challenge,
      signature: badSignature,
    })).rejects.toEqual(new WorkerAuthenticationError());
    const afterFailure = await fixtureDatabase.query<{ consumed_at: Date | null }>(`
      SELECT consumed_at FROM worker_session_challenges WHERE challenge_hash = $1
    `, [hashToken(challenge.challenge)]);
    expect(afterFailure.rows[0]?.consumed_at).toBeNull();

    await expect(service.createSession({
      workerId: worker.workerId,
      challenge: challenge.challenge,
      signature: signChallenge(challenge.challenge, worker.keys.privateKey),
    })).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("bounds concurrent anonymous challenge creation to one row per Worker", async () => {
    const worker = await enrollWorker();
    const firstDatabase = observedDatabase();
    const secondDatabase = observedDatabase();
    const gate = firstDatabase.holdAfterQuery((statement) =>
      statement.includes("pg_try_advisory_xact_lock"));

    const first = workerService(firstDatabase).createChallenge(worker.workerId);
    await gate.entered.promise;
    let secondResult;
    try {
      secondResult = await outcome(
        workerService(secondDatabase).createChallenge(worker.workerId),
      );
    } finally {
      gate.release.resolve();
    }

    const challenge = await first;
    expect(secondResult).toEqual({
      status: "rejected",
      reason: new WorkerChallengeRateLimitedError(),
    });
    await expect(workerService(fixtureDatabase).createChallenge(worker.workerId)).rejects.toEqual(
      new WorkerChallengeRateLimitedError(),
    );
    const slots = await fixtureDatabase.query<{ count: string; challenge_hash: Buffer }>(`
      SELECT count(*) OVER()::text AS count, challenge_hash
      FROM worker_session_challenges
      WHERE worker_id = $1
    `, [worker.workerId]);
    expect(slots.rows[0]).toEqual({ count: "1", challenge_hash: hashToken(challenge.challenge) });
  });

  it("reuses a consumed Worker slot immediately and invalidates the old challenge", async () => {
    const worker = await enrollWorker();
    const service = workerService(fixtureDatabase);
    const first = await service.createChallenge(worker.workerId);
    await service.createSession({
      workerId: worker.workerId,
      challenge: first.challenge,
      signature: signChallenge(first.challenge, worker.keys.privateKey),
    });

    const second = await service.createChallenge(worker.workerId);
    expect(second.challenge).not.toBe(first.challenge);
    await expect(service.createSession({
      workerId: worker.workerId,
      challenge: first.challenge,
      signature: signChallenge(first.challenge, worker.keys.privateKey),
    })).rejects.toEqual(new WorkerAuthenticationError());
    await expect(service.createSession({
      workerId: worker.workerId,
      challenge: second.challenge,
      signature: signChallenge(second.challenge, worker.keys.privateKey),
    })).resolves.toMatchObject({ token: expect.any(String) });
    const slots = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM worker_session_challenges
      WHERE worker_id = $1
    `, [worker.workerId]);
    expect(slots.rows[0]?.count).toBe("1");
  });

  it("replaces an unconsumed Worker slot after the cooldown and invalidates its secret", async () => {
    const worker = await enrollWorker();
    const service = workerService(fixtureDatabase);
    const first = await service.createChallenge(worker.workerId);
    await fixtureDatabase.query(`
      UPDATE worker_session_challenges
      SET created_at = clock_timestamp() - INTERVAL '2 seconds'
      WHERE worker_id = $1
    `, [worker.workerId]);

    const second = await service.createChallenge(worker.workerId);
    expect(second.challenge).not.toBe(first.challenge);
    await expect(service.createSession({
      workerId: worker.workerId,
      challenge: first.challenge,
      signature: signChallenge(first.challenge, worker.keys.privateKey),
    })).rejects.toEqual(new WorkerAuthenticationError());
    await expect(service.createSession({
      workerId: worker.workerId,
      challenge: second.challenge,
      signature: signChallenge(second.challenge, worker.keys.privateKey),
    })).resolves.toMatchObject({ token: expect.any(String) });
    const slots = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM worker_session_challenges
      WHERE worker_id = $1
    `, [worker.workerId]);
    expect(slots.rows[0]?.count).toBe("1");
  });

  it("lets different Workers create isolated challenge slots", async () => {
    const first = await enrollWorker();
    const second = await enrollWorker();
    const firstDatabase = observedDatabase();
    const gate = firstDatabase.holdAfterQuery((statement) =>
      statement.includes("pg_try_advisory_xact_lock"));
    const firstPromise = workerService(firstDatabase).createChallenge(first.workerId);
    await gate.entered.promise;
    let secondChallenge;
    try {
      secondChallenge = await workerService(fixtureDatabase).createChallenge(second.workerId);
    } finally {
      gate.release.resolve();
    }
    const firstChallenge = await firstPromise;
    expect(firstChallenge.workerId).toBe(first.workerId);
    expect(secondChallenge.workerId).toBe(second.workerId);
    const slots = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM worker_session_challenges
    `, []);
    expect(slots.rows[0]?.count).toBe("2");
  });

  it("serializes challenge replacement behind an in-flight valid session exchange", async () => {
    const worker = await enrollWorker();
    const initial = await workerService(fixtureDatabase).createChallenge(worker.workerId);
    const sessionDatabase = observedDatabase();
    const replacementDatabase = observedDatabase();
    const gate = sessionDatabase.holdAfterQuery((statement) =>
      statement.includes("FOR UPDATE OF challenges"));
    const session = workerService(sessionDatabase).createSession({
      workerId: worker.workerId,
      challenge: initial.challenge,
      signature: signChallenge(initial.challenge, worker.keys.privateKey),
    });
    await gate.entered.promise;
    const replacement = outcome(
      workerService(replacementDatabase).createChallenge(worker.workerId),
    );
    const replacementPid = await replacementDatabase.transactionStarted.promise;
    try {
      await expect(waitForLock(replacementPid)).resolves.toBe("Lock");
    } finally {
      gate.release.resolve();
    }

    await expect(session).resolves.toMatchObject({ token: expect.any(String) });
    const replacementResult = await replacement;
    expect(replacementResult.status).toBe("fulfilled");
    if (replacementResult.status !== "fulfilled") throw replacementResult.reason;
    const replaced = replacementResult.value;
    expect(replaced.challenge).not.toBe(initial.challenge);
    await expect(workerService(fixtureDatabase).createSession({
      workerId: worker.workerId,
      challenge: initial.challenge,
      signature: signChallenge(initial.challenge, worker.keys.privateKey),
    })).rejects.toEqual(new WorkerAuthenticationError());
    const slots = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM worker_session_challenges WHERE worker_id = $1
    `, [worker.workerId]);
    expect(slots.rows[0]?.count).toBe("1");
  });

  it("allows only one backend to exchange a signed challenge", async () => {
    const worker = await enrollWorker();
    const challenge = await workerService(fixtureDatabase).createChallenge(worker.workerId);
    const input = {
      workerId: worker.workerId,
      challenge: challenge.challenge,
      signature: signChallenge(challenge.challenge, worker.keys.privateKey),
    };
    const firstDatabase = observedDatabase();
    const secondDatabase = observedDatabase();
    const gate = firstDatabase.holdAfterQuery((statement) =>
      statement.includes("FOR UPDATE OF challenges"));

    const first = workerService(firstDatabase).createSession(input);
    await gate.entered.promise;
    const second = outcome(workerService(secondDatabase).createSession(input));
    const firstPid = await firstDatabase.transactionStarted.promise;
    const secondPid = await secondDatabase.transactionStarted.promise;
    expect(firstPid).not.toBe(secondPid);
    await expect(waitForLock(secondPid)).resolves.toBe("Lock");
    gate.release.resolve();

    await expect(first).resolves.toMatchObject({ token: expect.any(String) });
    const secondResult = await second;
    expect(secondResult).toEqual({
      status: "rejected",
      reason: new WorkerAuthenticationError(),
    });
    const sessions = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM worker_sessions WHERE worker_id = $1
    `, [worker.workerId]);
    expect(sessions.rows[0]?.count).toBe("1");
  });

  it("rolls back challenge consumption after session insert or JWT signing failure", async () => {
    const worker = await enrollWorker();
    const service = workerService(fixtureDatabase);
    const databaseFailureChallenge = await service.createChallenge(worker.workerId);
    const databaseFailureInput = {
      workerId: worker.workerId,
      challenge: databaseFailureChallenge.challenge,
      signature: signChallenge(databaseFailureChallenge.challenge, worker.keys.privateKey),
    };
    await fixtureDatabase.query(`
      CREATE FUNCTION fail_worker_session_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected session insert failure';
      END;
      $$
    `, []);
    await fixtureDatabase.query(`
      CREATE TRIGGER fail_worker_session_insert
      BEFORE INSERT ON worker_sessions
      FOR EACH ROW EXECUTE FUNCTION fail_worker_session_insert()
    `, []);

    await expect(service.createSession(databaseFailureInput))
      .rejects.toThrow("injected session insert failure");
    let state = await fixtureDatabase.query<{ consumed_at: Date | null; sessions: string }>(`
      SELECT challenge.consumed_at,
        (SELECT count(*) FROM worker_sessions WHERE worker_id = $2)::text AS sessions
      FROM worker_session_challenges AS challenge
      WHERE challenge.challenge_hash = $1
    `, [hashToken(databaseFailureChallenge.challenge), worker.workerId]);
    expect(state.rows[0]).toEqual({ consumed_at: null, sessions: "0" });
    await fixtureDatabase.query("DROP TRIGGER fail_worker_session_insert ON worker_sessions", []);
    await fixtureDatabase.query("DROP FUNCTION fail_worker_session_insert()", []);
    await expect(service.createSession(databaseFailureInput))
      .resolves.toMatchObject({ token: expect.any(String) });

    const signingFailureChallenge = await service.createChallenge(worker.workerId);
    const signingFailureInput = {
      workerId: worker.workerId,
      challenge: signingFailureChallenge.challenge,
      signature: signChallenge(signingFailureChallenge.challenge, worker.keys.privateKey),
    };
    const badConfig: WorkerIdentityConfig = {
      ...workerConfig,
      sessionTokenPrivateKey: workerTokenKeys.publicKey,
    };
    await expect(workerService(fixtureDatabase, badConfig).createSession(signingFailureInput))
      .rejects.toThrow();
    state = await fixtureDatabase.query<{ consumed_at: Date | null; sessions: string }>(`
      SELECT challenge.consumed_at,
        (SELECT count(*) FROM worker_sessions WHERE worker_id = $2)::text AS sessions
      FROM worker_session_challenges AS challenge
      WHERE challenge.challenge_hash = $1
    `, [hashToken(signingFailureChallenge.challenge), worker.workerId]);
    expect(state.rows[0]).toEqual({ consumed_at: null, sessions: "1" });
    await expect(service.createSession(signingFailureInput))
      .resolves.toMatchObject({ token: expect.any(String) });
  });

  it("serializes one refresh success and one rotation conflict with an active family tip", async () => {
    const rawToken = refreshToken("A");
    const familyId = randomUUID();
    const oldId = await insertRefresh({ rawToken, familyId });
    const firstDatabase = observedDatabase();
    const secondDatabase = observedDatabase();
    const gate = firstDatabase.holdAfterQuery((statement) =>
      statement.includes("FROM refresh_tokens") && statement.includes("FOR UPDATE"));

    const first = oidcService(firstDatabase).rotateRefreshToken(rawToken);
    await gate.entered.promise;
    const second = outcome(oidcService(secondDatabase).rotateRefreshToken(rawToken));
    const firstPid = await firstDatabase.transactionStarted.promise;
    const secondPid = await secondDatabase.transactionStarted.promise;
    expect(firstPid).not.toBe(secondPid);
    await expect(waitForLock(secondPid)).resolves.toBe("Lock");
    gate.release.resolve();

    const firstTokens = await first;
    const secondResult = await second;
    expect(secondResult).toEqual({
      status: "rejected",
      reason: new RefreshTokenRotationConflictError(),
    });
    const family = await fixtureDatabase.query<{
      id: string;
      previous_token_id: string | null;
      token_hash: Buffer;
      used_at: Date | null;
      revoked_at: Date | null;
    }>(`
      SELECT id, previous_token_id, token_hash, used_at, revoked_at
      FROM refresh_tokens
      WHERE family_id = $1
      ORDER BY created_at, id
    `, [familyId]);
    expect(family.rows).toHaveLength(2);
    expect(family.rows.find((row) => row.id === oldId)).toMatchObject({
      used_at: expect.any(Date),
      revoked_at: null,
    });
    expect(family.rows.find((row) => row.previous_token_id === oldId)).toMatchObject({
      token_hash: hashToken(firstTokens.refreshToken),
      used_at: null,
      revoked_at: null,
    });
    await expect(oidcService(fixtureDatabase).verifyAccessToken(firstTokens.accessToken))
      .resolves.toEqual({ userId });
  });

  it("revokes the successor when logout waits for an in-flight refresh", async () => {
    const rawToken = refreshToken("L");
    const familyId = randomUUID();
    await insertRefresh({ rawToken, familyId });
    const rotatingDatabase = observedDatabase();
    const logoutDatabase = observedDatabase();
    const backend = await logoutDatabase.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", []);
    const gate = rotatingDatabase.holdAfterQuery((statement) =>
      statement.includes("FROM refresh_tokens") && statement.includes("FOR UPDATE"));
    const rotating = outcome(oidcService(rotatingDatabase).rotateRefreshToken(rawToken));
    await gate.entered.promise;
    const logout = outcome(oidcService(logoutDatabase).revokeAllUserSessions(userId));
    try {
      await expect(waitForLock(backend.rows[0]!.pid)).resolves.toBe("Lock");
    } finally {
      gate.release.resolve();
    }
    const rotated = await rotating;
    expect(rotated.status).toBe("fulfilled");
    expect(await logout).toEqual({ status: "fulfilled", value: 2 });
    if (rotated.status !== "fulfilled") throw rotated.reason;
    await expect(oidcService(fixtureDatabase).verifyAccessToken(rotated.value.accessToken))
      .rejects.toEqual(new AccessTokenAuthenticationError());
    await expect(oidcService(fixtureDatabase).rotateRefreshToken(rotated.value.refreshToken))
      .rejects.toEqual(new RefreshTokenAuthenticationError());
    const active = await fixtureDatabase.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL
    `, [userId]);
    expect(active.rows[0]?.count).toBe("0");
  });

  it("rejects a refresh that waits behind logout without creating a successor", async () => {
    const rawToken = refreshToken("M");
    await insertRefresh({ rawToken, familyId: randomUUID() });
    const logoutDatabase = observedDatabase();
    const rotatingDatabase = observedDatabase();
    const gate = logoutDatabase.holdAfterQuery((statement) =>
      statement.includes("UPDATE refresh_tokens"));
    const logout = outcome(oidcService(logoutDatabase).revokeAllUserSessions(userId));
    await gate.entered.promise;
    const rotating = outcome(oidcService(rotatingDatabase).rotateRefreshToken(rawToken));
    try {
      const pid = await rotatingDatabase.transactionStarted.promise;
      await expect(waitForLock(pid)).resolves.toBe("Lock");
    } finally {
      gate.release.resolve();
    }
    expect(await logout).toEqual({ status: "fulfilled", value: 1 });
    expect(await rotating).toEqual({
      status: "rejected", reason: new RefreshTokenAuthenticationError(),
    });
    const tokens = await fixtureDatabase.query<{ count: string; revoked: string }>(`
      SELECT count(*)::text AS count, count(revoked_at)::text AS revoked
      FROM refresh_tokens WHERE user_id = $1
    `, [userId]);
    expect(tokens.rows[0]).toEqual({ count: "1", revoked: "1" });
  });

  it("revokes the in-flight successor when an older family token is replayed", async () => {
    const familyId = randomUUID();
    const replayedToken = refreshToken("N");
    const oldId = await insertRefresh({
      rawToken: replayedToken, familyId, usedAt: new Date(now.getTime() - 5_001),
    });
    const currentToken = refreshToken("P");
    await insertRefresh({ rawToken: currentToken, familyId, previousTokenId: oldId });
    const otherFamilyId = randomUUID();
    await insertRefresh({ rawToken: refreshToken("Q"), familyId: otherFamilyId });
    const rotatingDatabase = observedDatabase();
    const replayDatabase = observedDatabase();
    const gate = rotatingDatabase.holdAfterQuery((statement) =>
      statement.includes("SELECT id, family_id") && statement.includes("FOR UPDATE"));
    const rotating = outcome(oidcService(rotatingDatabase).rotateRefreshToken(currentToken));
    await gate.entered.promise;
    const replay = outcome(oidcService(replayDatabase).rotateRefreshToken(replayedToken));
    try {
      const pid = await replayDatabase.transactionStarted.promise;
      await expect(waitForLock(pid)).resolves.toBe("Lock");
    } finally {
      gate.release.resolve();
    }
    const rotated = await rotating;
    expect(rotated.status).toBe("fulfilled");
    expect(await replay).toEqual({ status: "rejected", reason: new RefreshTokenReuseError() });
    if (rotated.status !== "fulfilled") throw rotated.reason;
    await expect(oidcService(fixtureDatabase).verifyAccessToken(rotated.value.accessToken))
      .rejects.toEqual(new AccessTokenAuthenticationError());
    await expect(oidcService(fixtureDatabase).rotateRefreshToken(rotated.value.refreshToken))
      .rejects.toEqual(new RefreshTokenAuthenticationError());
    const state = await fixtureDatabase.query<{ family_id: string; total: string; revoked: string }>(`
      SELECT family_id::text, count(*)::text AS total, count(revoked_at)::text AS revoked
      FROM refresh_tokens GROUP BY family_id
    `, []);
    expect(state.rows.find((row) => row.family_id === familyId))
      .toEqual({ family_id: familyId, total: "3", revoked: "3" });
    expect(state.rows.find((row) => row.family_id === otherFamilyId))
      .toEqual({ family_id: otherFamilyId, total: "1", revoked: "0" });
  });

  it("atomically revokes only a replayed refresh family outside the grace window", async () => {
    const replayedToken = refreshToken("B");
    const familyId = randomUUID();
    const oldId = await insertRefresh({
      rawToken: replayedToken,
      familyId,
      usedAt: new Date(now.getTime() - 5_001),
    });
    await insertRefresh({ rawToken: refreshToken("C"), familyId, previousTokenId: oldId });
    const otherFamilyId = randomUUID();
    await insertRefresh({ rawToken: refreshToken("D"), familyId: otherFamilyId });

    await expect(oidcService(fixtureDatabase).rotateRefreshToken(replayedToken))
      .rejects.toEqual(new RefreshTokenReuseError());
    const state = await fixtureDatabase.query<{
      family_id: string;
      total: string;
      revoked: string;
    }>(`
      SELECT family_id::text, count(*)::text AS total,
        count(revoked_at)::text AS revoked
      FROM refresh_tokens
      GROUP BY family_id
      ORDER BY family_id
    `, []);
    expect(state.rows.find((row) => row.family_id === familyId))
      .toEqual({ family_id: familyId, total: "2", revoked: "2" });
    expect(state.rows.find((row) => row.family_id === otherFamilyId))
      .toEqual({ family_id: otherFamilyId, total: "1", revoked: "0" });
  });

  it("rolls back a failed refresh successor insert and permits rotation retry", async () => {
    const rawToken = refreshToken("E");
    const familyId = randomUUID();
    const oldId = await insertRefresh({ rawToken, familyId });
    await fixtureDatabase.query(`
      CREATE FUNCTION fail_refresh_successor_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.previous_token_id IS NOT NULL THEN
          RAISE EXCEPTION 'injected refresh successor failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `, []);
    await fixtureDatabase.query(`
      CREATE TRIGGER fail_refresh_successor_insert
      BEFORE INSERT ON refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION fail_refresh_successor_insert()
    `, []);

    await expect(oidcService(fixtureDatabase).rotateRefreshToken(rawToken))
      .rejects.toThrow("injected refresh successor failure");
    const rolledBack = await fixtureDatabase.query<{ used_at: Date | null; count: string }>(`
      SELECT used_at, (SELECT count(*) FROM refresh_tokens WHERE family_id = $2)::text AS count
      FROM refresh_tokens WHERE id = $1
    `, [oldId, familyId]);
    expect(rolledBack.rows[0]).toEqual({ used_at: null, count: "1" });

    await fixtureDatabase.query("DROP TRIGGER fail_refresh_successor_insert ON refresh_tokens", []);
    await fixtureDatabase.query("DROP FUNCTION fail_refresh_successor_insert()", []);
    await expect(oidcService(fixtureDatabase).rotateRefreshToken(rawToken))
      .resolves.toMatchObject({ refreshToken: expect.stringMatching(/^dya_rt_/u) });
  });

  it("rolls back a failed replay revocation before atomically revoking that family", async () => {
    const replayedToken = refreshToken("F");
    const familyId = randomUUID();
    const oldId = await insertRefresh({
      rawToken: replayedToken,
      familyId,
      usedAt: new Date(now.getTime() - 5_001),
    });
    await insertRefresh({ rawToken: refreshToken("G"), familyId, previousTokenId: oldId });
    const otherFamilyId = randomUUID();
    await insertRefresh({ rawToken: refreshToken("H"), familyId: otherFamilyId });
    await fixtureDatabase.query(`
      CREATE FUNCTION fail_refresh_revoke() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
          RAISE EXCEPTION 'injected refresh revoke failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `, []);
    await fixtureDatabase.query(`
      CREATE TRIGGER fail_refresh_revoke
      BEFORE UPDATE ON refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION fail_refresh_revoke()
    `, []);

    await expect(oidcService(fixtureDatabase).rotateRefreshToken(replayedToken))
      .rejects.toThrow("injected refresh revoke failure");
    let state = await fixtureDatabase.query<{ family_id: string; revoked: string }>(`
      SELECT family_id::text, count(revoked_at)::text AS revoked
      FROM refresh_tokens
      GROUP BY family_id
    `, []);
    expect(state.rows).toEqual(expect.arrayContaining([
      { family_id: familyId, revoked: "0" },
      { family_id: otherFamilyId, revoked: "0" },
    ]));

    await fixtureDatabase.query("DROP TRIGGER fail_refresh_revoke ON refresh_tokens", []);
    await fixtureDatabase.query("DROP FUNCTION fail_refresh_revoke()", []);
    await expect(oidcService(fixtureDatabase).rotateRefreshToken(replayedToken))
      .rejects.toEqual(new RefreshTokenReuseError());
    state = await fixtureDatabase.query<{ family_id: string; revoked: string }>(`
      SELECT family_id::text, count(revoked_at)::text AS revoked
      FROM refresh_tokens
      GROUP BY family_id
    `, []);
    expect(state.rows).toEqual(expect.arrayContaining([
      { family_id: familyId, revoked: "2" },
      { family_id: otherFamilyId, revoked: "0" },
    ]));
  });
});
