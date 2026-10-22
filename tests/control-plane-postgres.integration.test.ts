import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPair } from "jose";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  AuthenticatedProjectApiKey,
  AuthenticatedWorker,
} from "../src/control-plane/api-key-service.js";
import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";
import {
  JobResultIdempotencyConflictError,
  JobResultService,
  type JobEventInput,
} from "../src/control-plane/organization-authorization.js";
import {
  ControlPlaneJobService,
  JobIdempotencyConflictError,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
  type CreateControlPlaneJobInput,
} from "../src/control-plane/project-scope.js";
import {
  PostgresControlPlaneDatabase,
  startControlPlaneRuntime,
} from "../src/server.js";
import { trackPoolErrors } from "./helpers.js";

const configuredDatabaseUrl = process.env.DIAOYAN_TEST_POSTGRES_URL;
const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;

function requiredDatabaseUrl(): string {
  if (configuredDatabaseUrl === undefined) {
    throw new Error(
      "DIAOYAN_TEST_POSTGRES_URL is required. Run the dedicated `pnpm test:postgres` Gate.",
    );
  }
  return configuredDatabaseUrl;
}

function quotedTestDatabase(name: string): string {
  if (!/^diaoyan_test_[0-9a-f]{32}$/u.test(name)) {
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

async function expectPostgresError(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected PostgreSQL error ${code}, but the statement succeeded.`);
}

const temporaryDirectories: string[] = [];

const fixture = Object.freeze({
  userId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000101",
  projectId: "00000000-0000-4000-8000-000000000201",
  workerId: "00000000-0000-4000-8000-000000000401",
  publicKeyId: "00000000-0000-4000-8000-000000000402",
  sessionId: "00000000-0000-4000-8000-000000000403",
  apiKeyId: "00000000-0000-4000-8000-000000000501",
});
let fixtureNow = new Date(0);
const fixtureCapabilityHash = Buffer.alloc(32, 3);
const fixtureWorker: AuthenticatedWorker = Object.freeze({
  workerId: fixture.workerId,
  projectId: fixture.projectId,
  sessionId: fixture.sessionId,
  capabilityHash: fixtureCapabilityHash.toString("base64url"),
});
const fixtureProjectKey: AuthenticatedProjectApiKey = Object.freeze({
  apiKeyId: fixture.apiKeyId,
  projectId: fixture.projectId,
  organizationId: fixture.organizationId,
  createdByUserId: fixture.userId,
  scopes: Object.freeze(["tasks:write"] as const),
});

async function seedRuntimeFixture(database: Pool): Promise<void> {
  await database.query(`
    INSERT INTO users(id, oidc_issuer, oidc_subject)
    VALUES ($1, $2, $3)
  `, [fixture.userId, "https://issuer.example", "db-03-user"]);
  await database.query(`
    INSERT INTO organizations(id, slug, name, kind)
    VALUES ($1, $2, $3, 'business')
  `, [fixture.organizationId, "db-03-organization", "DB-03 Organization"]);
  await database.query(`
    INSERT INTO projects(id, organization_id, slug, name)
    VALUES ($1, $2, $3, $4)
  `, [fixture.projectId, fixture.organizationId, "db-03-project", "DB-03 Project"]);
  await database.query(`
    INSERT INTO workers(
      id, project_id, name, kind, version, capability_manifest,
      capability_hash, created_by_user_id
    ) VALUES ($1, $2, $3, 'public', $4, $5::jsonb, $6, $7)
  `, [
    fixture.workerId,
    fixture.projectId,
    "db-03-worker",
    "1.0.0",
    JSON.stringify({ http: true }),
    fixtureCapabilityHash,
    fixture.userId,
  ]);
  await database.query(`
    INSERT INTO worker_public_keys(
      id, project_id, worker_id, algorithm, public_key_spki, fingerprint
    ) VALUES ($1, $2, $3, 'Ed25519', $4, $5)
  `, [
    fixture.publicKeyId,
    fixture.projectId,
    fixture.workerId,
    Buffer.from("db-03-public-key"),
    Buffer.alloc(32, 4),
  ]);
  await database.query(`
    INSERT INTO worker_sessions(
      id, project_id, worker_id, public_key_id, capability_hash, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    fixture.sessionId,
    fixture.projectId,
    fixture.workerId,
    fixture.publicKeyId,
    fixtureCapabilityHash,
    new Date("2031-01-01T00:00:00.000Z"),
  ]);
}

function jobInput(url: string): CreateControlPlaneJobInput {
  return Object.freeze({
    type: "read" as const,
    input: Object.freeze({ url }),
    dataClass: "public" as const,
    placement: Object.freeze({ class: "public" as const, pinnedWorkerId: null }),
    requiredCapabilities: Object.freeze({ http: true as const }),
    budget: Object.freeze({
      deadlineMs: 300_000,
      maxProviderAttempts: 2,
      maxDocumentBytes: 1_000_000,
      maxBrowserMs: 0,
      maxBrowserContexts: 0,
    }),
    policyVersion: "db-03-v1",
    uploadPrivateArtifact: false,
  });
}

function eventInput(localSequence: number, eventType: string): JobEventInput {
  return Object.freeze({
    localSequence,
    eventType,
    pageStatus: 200,
    errorCode: null,
    provider: "http",
    byteCount: 1_024 * localSequence,
    durationMs: 10 * localSequence,
    contentHash: Buffer.alloc(32, localSequence).toString("base64url"),
    usage: Object.freeze({ requests: 1 }),
    occurredAt: new Date(fixtureNow.getTime() + localSequence),
  });
}

class PostgresTransactionRendezvous {
  readonly backendPids: number[] = [];
  private readonly released: Promise<void>;
  private release!: () => void;

  constructor(pool: Pool, private readonly participants: number) {
    if (participants < 2 || pool.options.max < participants) {
      throw new Error(
        `PostgreSQL transaction rendezvous requires ${participants} pool connections; ` +
        `the pool provides ${pool.options.max}.`,
      );
    }
    this.released = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async arrive(transaction: ControlPlaneQuery): Promise<void> {
    const result = await transaction.query<{ backend_pid: number }>(`
      SELECT pg_backend_pid() AS backend_pid
    `, []);
    const backendPid = result.rows[0]?.backend_pid;
    if (
      typeof backendPid !== "number" ||
      !Number.isInteger(backendPid) ||
      this.backendPids.includes(backendPid)
    ) {
      throw new Error("Each PostgreSQL rendezvous participant must own a distinct backend.");
    }
    this.backendPids.push(backendPid);
    if (this.backendPids.length === this.participants) this.release();
    if (this.backendPids.length > this.participants) {
      throw new Error("Too many PostgreSQL transactions reached the rendezvous.");
    }
    await this.released;
  }
}

class RendezvousControlPlaneDatabase implements ControlPlaneDatabase {
  constructor(
    private readonly delegate: ControlPlaneDatabase,
    private readonly rendezvous: PostgresTransactionRendezvous,
    private readonly isCompetitionQuery: (statement: string) => boolean,
  ) {}

  query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    return this.delegate.query<Row>(statement, parameters);
  }

  transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    return this.delegate.transaction(async (transaction) => {
      let arrived = false;
      const controlled: ControlPlaneQuery = {
        query: async <Row>(statement: string, parameters: readonly unknown[]) => {
          if (!arrived && this.isCompetitionQuery(statement)) {
            arrived = true;
            await this.rendezvous.arrive(transaction);
          }
          return transaction.query<Row>(statement, parameters);
        },
      };
      return operation(controlled);
    });
  }
}

function expectTwoBackends(rendezvous: PostgresTransactionRendezvous): void {
  expect(rendezvous.backendPids).toHaveLength(2);
  expect(new Set(rendezvous.backendPids).size).toBe(2);
}

describeWithPostgres("control-plane migrations on PostgreSQL", () => {
  let administration: Pool;
  let database: Pool | undefined;
  let databaseName: string | undefined;
  const unexpectedPoolErrors: unknown[] = [];

  function testPool(connectionString: string, max: number): Pool {
    return trackPoolErrors(new Pool({ connectionString, max }), unexpectedPoolErrors);
  }

  beforeAll(async () => {
    administration = new Pool({ connectionString: requiredDatabaseUrl(), max: 1 });
    await administration.query("SELECT 1");
  });

  beforeEach(async () => {
    databaseName = `diaoyan_test_${randomUUID().replaceAll("-", "")}`;
    await administration.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
    database = testPool(databaseUrl(databaseName), 2);
    await database.query("SELECT 1");
    const clock = await database.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = clock.rows[0]?.now;
    if (!(now instanceof Date)) throw new Error("PostgreSQL did not return its current clock.");
    fixtureNow = now;
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      await database?.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    database = undefined;
    if (databaseName !== undefined) {
      try {
        await administration.query(`DROP DATABASE ${quotedTestDatabase(databaseName)} WITH (FORCE)`);
      } catch (error) {
        cleanupErrors.push(error);
      }
      databaseName = undefined;
    }
    try {
      await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    cleanupErrors.push(...unexpectedPoolErrors.splice(0));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "PostgreSQL integration test cleanup failed.");
    }
  });

  afterAll(async () => {
    await administration.end();
  });

  it("executes all twelve checked-in migrations on an empty database", async () => {
    await runControlPlaneMigrations(database!);
    await runControlPlaneMigrations(database!);

    const applied = await database!.query<{ version: number; name: string }>(`
      SELECT version, name
      FROM control_plane_schema_migrations
      ORDER BY version
    `);
    expect(applied.rows).toEqual([
      { version: 1, name: "0001_tenant_foundation.sql" },
      { version: 2, name: "0002_project_api_keys.sql" },
      { version: 3, name: "0003_oidc_sessions.sql" },
      { version: 4, name: "0004_worker_identity.sql" },
      { version: 5, name: "0005_jobs_and_leases.sql" },
      { version: 6, name: "0006_job_results.sql" },
      { version: 7, name: "0007_audit_events.sql" },
      { version: 8, name: "0008_bound_auth_attempts.sql" },
      { version: 9, name: "0009_project_creation_idempotency.sql" },
      { version: 10, name: "0010_webhooks.sql" },
      { version: 11, name: "0011_artifact_uploads.sql" },
      { version: 12, name: "0012_artifact_retention.sql" },
    ]);
  });

  it("refuses to bound Worker challenge slots while duplicate legacy rows exist", async () => {
    await runControlPlaneMigrations(database!);
    await seedRuntimeFixture(database!);
    await database!.query(`
      DELETE FROM control_plane_schema_migrations WHERE version >= 8;
      ALTER TABLE worker_session_challenges
        DROP CONSTRAINT worker_session_challenges_worker_unique;
      CREATE INDEX worker_session_challenges_worker_open
        ON worker_session_challenges(worker_id, expires_at)
        WHERE consumed_at IS NULL;
    `);
    await database!.query(`
      INSERT INTO worker_session_challenges(
        id, project_id, worker_id, public_key_id, challenge_hash,
        created_at, expires_at, consumed_at
      ) VALUES
        ($1, $2, $3, $4, $5, $6, $7, $6),
        ($8, $2, $3, $4, $9, $6, $7, NULL)
    `, [
      randomUUID(), fixture.projectId, fixture.workerId, fixture.publicKeyId,
      Buffer.alloc(32, 5), fixtureNow, new Date(fixtureNow.getTime() + 120_000),
      randomUUID(), Buffer.alloc(32, 6),
    ]);

    await expect(runControlPlaneMigrations(database!)).rejects.toThrow(
      "worker_session_challenges contains duplicate worker_id rows; " +
      "resolve them before migration",
    );

    const state = await database!.query<{
      applied: string;
      constraint_name: string | null;
      challenge_count: string;
      legacy_index: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM control_plane_schema_migrations WHERE version = 8) AS applied,
        (SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'worker_session_challenges'
            AND constraint_name = 'worker_session_challenges_worker_unique') AS constraint_name,
        (SELECT count(*)::text FROM worker_session_challenges
          WHERE worker_id = $1) AS challenge_count,
        to_regclass('public.worker_session_challenges_worker_open')::text AS legacy_index
    `, [fixture.workerId]);
    expect(state.rows[0]).toEqual({
      applied: "0",
      constraint_name: null,
      challenge_count: "2",
      legacy_index: "worker_session_challenges_worker_open",
    });
  });

  it("enforces the project-organization composite foreign key and audit triggers", async () => {
    await runControlPlaneMigrations(database!);
    await database!.query(`
      INSERT INTO users(id, oidc_issuer, oidc_subject)
      VALUES ('00000000-0000-4000-8000-000000000001', 'https://issuer.example', 'subject-1');

      INSERT INTO organizations(id, slug, name, kind)
      VALUES
        ('00000000-0000-4000-8000-000000000101', 'organization-a', 'Organization A', 'business'),
        ('00000000-0000-4000-8000-000000000102', 'organization-b', 'Organization B', 'business');

      INSERT INTO projects(id, organization_id, slug, name)
      VALUES (
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000101',
        'project-a',
        'Project A'
      );
    `);

    await expectPostgresError(
      () => database!.query(`
        INSERT INTO audit_events(
          id, organization_id, project_id, actor_type, actor_id, action,
          target_type, target_id, outcome, correlation_id
        ) VALUES (
          '00000000-0000-4000-8000-000000000301',
          '00000000-0000-4000-8000-000000000102',
          '00000000-0000-4000-8000-000000000201',
          'user', 'user-1', 'project.read', 'project', 'project-a', 'succeeded', 'correlation-1'
        )
      `),
      "23503",
    );

    await database!.query(`
      INSERT INTO audit_events(
        id, organization_id, project_id, actor_type, actor_id, action,
        target_type, target_id, outcome, correlation_id
      ) VALUES (
        '00000000-0000-4000-8000-000000000302',
        '00000000-0000-4000-8000-000000000101',
        '00000000-0000-4000-8000-000000000201',
        'user', 'user-1', 'project.read', 'project', 'project-a', 'succeeded', 'correlation-2'
      )
    `);

    await expectPostgresError(
      () => database!.query("UPDATE audit_events SET outcome = 'failed'"),
      "55000",
    );
    await expectPostgresError(() => database!.query("DELETE FROM audit_events"), "55000");
    await expectPostgresError(() => database!.query("TRUNCATE audit_events"), "55000");
  });

  it("rolls back a failed migration and does not execute later migrations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diaoyan-postgres-migrations-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(
        join(directory, "0001_stable.sql"),
        "BEGIN;\nCREATE TABLE stable_marker(id INTEGER PRIMARY KEY);\nCOMMIT;\n",
      ),
      writeFile(
        join(directory, "0002_fails.sql"),
        "BEGIN;\nCREATE TABLE rolled_back_marker(id INTEGER);\nINSERT INTO missing_marker VALUES (1);\nCOMMIT;\n",
      ),
      writeFile(
        join(directory, "0003_must_not_run.sql"),
        "BEGIN;\nCREATE TABLE later_marker(id INTEGER);\nCOMMIT;\n",
      ),
    ]);

    await expect(runControlPlaneMigrations(database!, directory)).rejects.toThrow(
      /missing_marker/u,
    );

    const state = await database!.query<{
      stable: string | null;
      rolled_back: string | null;
      later: string | null;
    }>(`
      SELECT
        to_regclass('public.stable_marker') AS stable,
        to_regclass('public.rolled_back_marker') AS rolled_back,
        to_regclass('public.later_marker') AS later
    `);
    expect(state.rows[0]).toEqual({
      stable: "stable_marker",
      rolled_back: null,
      later: null,
    });

    const applied = await database!.query<{ version: number }>(`
      SELECT version FROM control_plane_schema_migrations ORDER BY version
    `);
    expect(applied.rows).toEqual([{ version: 1 }]);
  });

  it("allows exactly one concurrent claim of a queued Job", async () => {
    await runControlPlaneMigrations(database!);
    await seedRuntimeFixture(database!);
    const storage = new PostgresControlPlaneDatabase(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => fixtureNow });
    const created = await jobs.createJob(
      fixtureProjectKey,
      "db-03-concurrent-claim",
      jobInput("https://example.com/claim"),
      { correlationId: "db-03-concurrent-claim" },
    );

    const rendezvous = new PostgresTransactionRendezvous(database!, 2);
    const competingJobs = new ControlPlaneJobService(new RendezvousControlPlaneDatabase(
      storage,
      rendezvous,
      (statement) => statement.includes("FOR UPDATE OF jobs SKIP LOCKED"),
    ), { now: () => fixtureNow });
    const attempts = await Promise.all([
      competingJobs.claimNext(fixtureWorker),
      competingJobs.claimNext(fixtureWorker),
    ]);
    const claims = attempts.filter((attempt) => attempt !== null);

    expectTwoBackends(rendezvous);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      job: { id: created.id, status: "running" },
      lease: { jobId: created.id, generation: 1 },
    });
    const state = await database!.query<{
      job_status: string;
      active_leases: string;
      generations: string[];
    }>(`
      SELECT jobs.status AS job_status,
        count(job_leases.id) FILTER (WHERE job_leases.status = 'active') AS active_leases,
        array_agg(job_leases.generation ORDER BY job_leases.generation) AS generations
      FROM jobs
      LEFT JOIN job_leases ON job_leases.job_id = jobs.id
      WHERE jobs.id = $1
      GROUP BY jobs.status
    `, [created.id]);
    expect(state.rows).toEqual([{
      job_status: "running",
      active_leases: "1",
      generations: ["1"],
    }]);
  });

  it("serializes concurrent event sequences and preserves local idempotency", async () => {
    await runControlPlaneMigrations(database!);
    await seedRuntimeFixture(database!);
    const storage = new PostgresControlPlaneDatabase(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => fixtureNow });
    const results = new JobResultService(storage);
    await jobs.createJob(
      fixtureProjectKey,
      "db-03-event-sequence",
      jobInput("https://example.com/events"),
      { correlationId: "db-03-event-sequence" },
    );
    const claim = await jobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("The DB-03 event Job was not claimed.");
    const firstInput = eventInput(10, "page-fetched");
    const secondInput = eventInput(20, "page-parsed");

    const rendezvous = new PostgresTransactionRendezvous(database!, 2);
    const competingResults = new JobResultService(new RendezvousControlPlaneDatabase(
      storage,
      rendezvous,
      (statement) => statement.includes("SELECT job_id FROM job_leases"),
    ));
    const events = await Promise.all([
      competingResults.appendEvent(
        fixtureWorker, claim.lease.id, claim.lease.generation, firstInput,
      ),
      competingResults.appendEvent(
        fixtureWorker, claim.lease.id, claim.lease.generation, secondInput,
      ),
    ]);

    expectTwoBackends(rendezvous);
    expect(events.map((event) => event.sequence).sort((left, right) => left - right))
      .toEqual([1, 2]);
    const stored = await database!.query<{
      id: string;
      local_sequence: string;
      sequence: string;
      event_type: string;
    }>(`
      SELECT id, local_sequence, sequence, event_type
      FROM job_events
      WHERE job_id = $1
      ORDER BY sequence
    `, [claim.job.id]);
    expect(stored.rows.map((row) => ({
      localSequence: Number(row.local_sequence),
      sequence: Number(row.sequence),
      eventType: row.event_type,
    }))).toEqual(events
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => ({
        localSequence: event.localSequence,
        sequence: event.sequence,
        eventType: event.eventType,
      })));

    const replay = await results.appendEvent(
      fixtureWorker,
      claim.lease.id,
      claim.lease.generation,
      firstInput,
    );
    expect(replay.id).toBe(events[0]!.localSequence === firstInput.localSequence
      ? events[0]!.id
      : events[1]!.id);
    await expect(results.appendEvent(
      fixtureWorker,
      claim.lease.id,
      claim.lease.generation,
      { ...firstInput, eventType: "conflicting-event" },
    )).rejects.toBeInstanceOf(JobResultIdempotencyConflictError);
    await expect(database!.query<{ count: string }>(`
      SELECT count(*) AS count FROM job_events WHERE job_id = $1
    `, [claim.job.id])).resolves.toMatchObject({ rows: [{ count: "2" }] });
  });

  it("deduplicates concurrent Job creation and rejects conflicting key reuse", async () => {
    await runControlPlaneMigrations(database!);
    await seedRuntimeFixture(database!);
    const storage = new PostgresControlPlaneDatabase(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => fixtureNow });
    const input = jobInput("https://example.com/idempotent");
    const rendezvous = new PostgresTransactionRendezvous(database!, 2);
    const competingJobs = new ControlPlaneJobService(new RendezvousControlPlaneDatabase(
      storage,
      rendezvous,
      (statement) => statement.includes("INSERT INTO jobs("),
    ), { now: () => fixtureNow });

    const created = await Promise.all([
      competingJobs.createJob(fixtureProjectKey, "db-03-idempotent", input, {
        correlationId: "db-03-idempotent-a",
      }),
      competingJobs.createJob(fixtureProjectKey, "db-03-idempotent", input, {
        correlationId: "db-03-idempotent-b",
      }),
    ]);

    expectTwoBackends(rendezvous);
    expect(created[0]!.id).toBe(created[1]!.id);
    await expect(jobs.createJob(
      fixtureProjectKey,
      "db-03-idempotent",
      jobInput("https://example.com/conflict"),
      { correlationId: "db-03-idempotent-conflict" },
    )).rejects.toBeInstanceOf(JobIdempotencyConflictError);
    await expect(database!.query<{ count: string }>(`
      SELECT count(*) AS count FROM jobs WHERE project_id = $1 AND idempotency_key = $2
    `, [fixture.projectId, "db-03-idempotent"])).resolves.toMatchObject({
      rows: [{ count: "1" }],
    });
  });

  it("retains claimed Job and event state across Control Plane runtime restart", async () => {
    await runControlPlaneMigrations(database!);
    await seedRuntimeFixture(database!);
    const initialStorage = new PostgresControlPlaneDatabase(database!);
    const initialJobs = new ControlPlaneJobService(initialStorage, { now: () => fixtureNow });
    const initialResults = new JobResultService(initialStorage);
    const created = await initialJobs.createJob(
      fixtureProjectKey,
      "db-03-restart",
      jobInput("https://example.com/restart"),
      { correlationId: "db-03-restart" },
    );
    const claim = await initialJobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("The DB-03 restart Job was not claimed.");
    const input = eventInput(1, "checkpoint-created");
    const event = await initialResults.appendEvent(
      fixtureWorker,
      claim.lease.id,
      claim.lease.generation,
      input,
    );

    await database!.end();
    database = undefined;
    const connectionString = databaseUrl(databaseName!);
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const human = await generateKeyPair("EdDSA");
    const runtimeConfig = {
      database: { connectionString, max: 2 },
      humanIdentity: {
        issuer: "https://identity.db-03.example",
        authorizationEndpoint: "https://identity.db-03.example/authorize",
        tokenEndpoint: "https://identity.db-03.example/token",
        clientId: "db-03",
        redirectUri: "https://db-03.control.example/v1/auth/oidc/callback",
        idTokenAlgorithms: ["EdDSA"],
        idTokenVerificationKey: human.publicKey,
        accessTokenIssuer: "https://db-03.control.example",
        accessTokenAudience: "db-03-human",
        accessTokenPrivateKey: human.privateKey,
        accessTokenPublicKey: human.publicKey,
      },
      identity: {
        sessionTokenIssuer: "https://db-03.control.example",
        sessionTokenAudience: "db-03-worker",
        sessionTokenPrivateKey: privateKey,
        sessionTokenPublicKey: publicKey,
      },
      listener: { host: "127.0.0.1", port: 0, tls: null },
    } as const;
    const firstRuntime = await startControlPlaneRuntime(runtimeConfig);
    try {
      expect(firstRuntime.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
    } finally {
      await firstRuntime.close();
    }
    const restartedRuntime = await startControlPlaneRuntime(runtimeConfig);
    try {
      expect(restartedRuntime.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
    } finally {
      await restartedRuntime.close();
    }

    database = testPool(connectionString, 2);
    await database.query("SELECT 1");
    const restartedStorage = new PostgresControlPlaneDatabase(database);
    const restartedJobs = new ControlPlaneJobService(restartedStorage, { now: () => fixtureNow });
    const restartedResults = new JobResultService(restartedStorage);

    await expect(restartedJobs.getJob(fixtureProjectKey, created.id)).resolves.toMatchObject({
      id: created.id,
      status: "running",
    });
    await expect(restartedResults.appendEvent(
      fixtureWorker,
      claim.lease.id,
      claim.lease.generation,
      input,
    )).resolves.toMatchObject({ id: event.id, sequence: event.sequence });
    await expect(database.query<{ count: string }>(`
      SELECT count(*) AS count FROM job_events WHERE job_id = $1
    `, [created.id])).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("rejects a two-party transaction rendezvous on a single-connection pool", async () => {
    const singleConnection = new Pool({ connectionString: databaseUrl(databaseName!), max: 1 });
    try {
      expect(() => new PostgresTransactionRendezvous(singleConnection, 2)).toThrow(
        "PostgreSQL transaction rendezvous requires 2 pool connections; the pool provides 1.",
      );
    } finally {
      await singleConnection.end();
    }
  });
});
