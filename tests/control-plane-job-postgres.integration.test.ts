import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuthenticatedProjectApiKey,
  AuthenticatedWorker,
} from "../src/control-plane/api-key-service.js";
import { ControlPlaneJobLeaseSweeper } from "../src/control-plane/job-lease-recovery.js";
import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";
import {
  JobResultLeaseFencedError,
  JobResultService,
  type JobEventInput,
  type PublishJobResultInput,
} from "../src/control-plane/organization-authorization.js";
import {
  ControlPlaneJobService,
  LeaseFencedError,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
  type CreateControlPlaneJobInput,
} from "../src/control-plane/project-scope.js";
import { unlimitedProjectQuotas } from "../src/control-plane/quotas.js";
import { PostgresControlPlaneDatabase } from "../src/server.js";

const configuredDatabaseUrl = process.env.DIAOYAN_TEST_POSTGRES_URL;
const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;

const fixture = Object.freeze({
  userId: "00000000-0000-4000-8000-000000001001",
  organizationId: "00000000-0000-4000-8000-000000001101",
  projectId: "00000000-0000-4000-8000-000000001201",
  workerId: "00000000-0000-4000-8000-000000001401",
  publicKeyId: "00000000-0000-4000-8000-000000001402",
  sessionId: "00000000-0000-4000-8000-000000001403",
  apiKeyId: "00000000-0000-4000-8000-000000001501",
  privateWorkerId: "00000000-0000-4000-8000-000000001411",
  privatePublicKeyId: "00000000-0000-4000-8000-000000001412",
  privateSessionId: "00000000-0000-4000-8000-000000001413",
  pinnedWorkerId: "00000000-0000-4000-8000-000000001421",
  pinnedPublicKeyId: "00000000-0000-4000-8000-000000001422",
  pinnedSessionId: "00000000-0000-4000-8000-000000001423",
});
const fixtureNow = new Date("2030-01-01T00:00:00.000Z");
const fixtureCapabilityHash = Buffer.alloc(32, 13);
const fixtureWorker: AuthenticatedWorker = Object.freeze({
  workerId: fixture.workerId,
  projectId: fixture.projectId,
  sessionId: fixture.sessionId,
  capabilityHash: fixtureCapabilityHash.toString("base64url"),
});
const privateCapabilityHash = Buffer.alloc(32, 15);
const privateWorker: AuthenticatedWorker = Object.freeze({
  workerId: fixture.privateWorkerId,
  projectId: fixture.projectId,
  sessionId: fixture.privateSessionId,
  capabilityHash: privateCapabilityHash.toString("base64url"),
});
const pinnedCapabilityHash = Buffer.alloc(32, 16);
const pinnedWorker: AuthenticatedWorker = Object.freeze({
  workerId: fixture.pinnedWorkerId,
  projectId: fixture.projectId,
  sessionId: fixture.pinnedSessionId,
  capabilityHash: pinnedCapabilityHash.toString("base64url"),
});
const fixtureProjectKey: AuthenticatedProjectApiKey = Object.freeze({
  apiKeyId: fixture.apiKeyId,
  projectId: fixture.projectId,
  organizationId: fixture.organizationId,
  createdByUserId: fixture.userId,
  scopes: Object.freeze(["tasks:write"] as const),
});

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
  url.searchParams.set("application_name", "diaoyan-job-03");
  return url.toString();
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
    policyVersion: "job-03-v1",
    uploadPrivateArtifact: false,
  });
}

function privateJobInput(
  url: string,
  pinnedWorkerId: string | null,
): CreateControlPlaneJobInput {
  return Object.freeze({
    ...jobInput(url),
    dataClass: "authorized" as const,
    placement: Object.freeze({ class: "private" as const, pinnedWorkerId }),
  });
}

function eventInput(localSequence: number): JobEventInput {
  return Object.freeze({
    localSequence,
    eventType: "page-fetched",
    pageStatus: 200,
    errorCode: null,
    provider: "http",
    byteCount: 1_024,
    durationMs: 25,
    contentHash: Buffer.alloc(32, 21).toString("base64url"),
    usage: Object.freeze({ requests: 1 }),
    occurredAt: new Date(fixtureNow.getTime() + localSequence),
  });
}

function publicationInput(localSequence: number): PublishJobResultInput {
  return Object.freeze({
    localSequence,
    contentHash: Buffer.alloc(32, 22).toString("base64url"),
    byteCount: 2_048,
    mediaType: "text/markdown",
    completeness: "complete" as const,
    storage: "worker_local" as const,
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

async function seedRuntimeFixture(database: Pool): Promise<void> {
  await database.query(`
    INSERT INTO users(id, oidc_issuer, oidc_subject)
    VALUES ($1, $2, $3)
  `, [fixture.userId, "https://issuer.example", "job-03-user"]);
  await database.query(`
    INSERT INTO organizations(id, slug, name, kind)
    VALUES ($1, $2, $3, 'business')
  `, [fixture.organizationId, "job-03-organization", "JOB-03 Organization"]);
  await database.query(`
    INSERT INTO projects(id, organization_id, slug, name)
    VALUES ($1, $2, $3, $4)
  `, [fixture.projectId, fixture.organizationId, "job-03-project", "JOB-03 Project"]);
  await database.query(`
    INSERT INTO workers(
      id, project_id, name, kind, version, capability_manifest,
      capability_hash, created_by_user_id
    ) VALUES ($1, $2, $3, 'public', $4, $5::jsonb, $6, $7)
  `, [
    fixture.workerId,
    fixture.projectId,
    "job-03-worker",
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
    Buffer.from("job-03-public-key"),
    Buffer.alloc(32, 14),
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
  for (const worker of [
    {
      id: fixture.privateWorkerId,
      keyId: fixture.privatePublicKeyId,
      sessionId: fixture.privateSessionId,
      name: "job-03-private-worker",
      capabilityHash: privateCapabilityHash,
      fingerprint: Buffer.alloc(32, 17),
    },
    {
      id: fixture.pinnedWorkerId,
      keyId: fixture.pinnedPublicKeyId,
      sessionId: fixture.pinnedSessionId,
      name: "job-03-pinned-worker",
      capabilityHash: pinnedCapabilityHash,
      fingerprint: Buffer.alloc(32, 18),
    },
  ]) {
    await database.query(`
      INSERT INTO workers(
        id, project_id, name, kind, version, capability_manifest,
        capability_hash, created_by_user_id
      ) VALUES ($1, $2, $3, 'private', $4, $5::jsonb, $6, $7)
    `, [
      worker.id,
      fixture.projectId,
      worker.name,
      "1.0.0",
      JSON.stringify({ http: true }),
      worker.capabilityHash,
      fixture.userId,
    ]);
    await database.query(`
      INSERT INTO worker_public_keys(
        id, project_id, worker_id, algorithm, public_key_spki, fingerprint
      ) VALUES ($1, $2, $3, 'Ed25519', $4, $5)
    `, [
      worker.keyId,
      fixture.projectId,
      worker.id,
      Buffer.from(`${worker.name}-public-key`),
      worker.fingerprint,
    ]);
    await database.query(`
      INSERT INTO worker_sessions(
        id, project_id, worker_id, public_key_id, capability_hash, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      worker.sessionId,
      fixture.projectId,
      worker.id,
      worker.keyId,
      worker.capabilityHash,
      new Date("2031-01-01T00:00:00.000Z"),
    ]);
  }
}

async function databaseClock(database: Pool): Promise<Date> {
  const result = await database.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new Error("PostgreSQL did not return its current clock.");
  return now;
}

describeWithPostgres("control-plane Job lifecycle on PostgreSQL", () => {
  let administration: Pool;
  let database: Pool | undefined;
  let databaseName: string | undefined;

  beforeAll(async () => {
    administration = new Pool({ connectionString: requiredDatabaseUrl(), max: 1 });
    await administration.query("SELECT 1");
  });

  beforeEach(async () => {
    databaseName = `diaoyan_test_${randomUUID().replaceAll("-", "")}`;
    await administration.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
    const connectionString = databaseUrl(databaseName);
    database = new Pool({ connectionString, max: 2 });
    await database.query("SELECT 1");
    await runControlPlaneMigrations(database);
    await seedRuntimeFixture(database);
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    for (const pool of [database]) {
      try {
        await pool?.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    database = undefined;
    if (databaseName !== undefined) {
      try {
        await administration.query(`DROP DATABASE ${quotedTestDatabase(databaseName)}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
      databaseName = undefined;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "PostgreSQL Job test cleanup failed.");
    }
  });

  afterAll(async () => {
    await administration.end();
  });

  it("runs claim, heartbeat, event, publication, and completion as one durable lifecycle", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => now });
    const created = await jobs.createJob(
      fixtureProjectKey,
      "job-03-complete-lifecycle",
      jobInput("https://example.com/complete-lifecycle"),
      { correlationId: "job-03-complete-lifecycle" },
    );
    const claim = await jobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("The PostgreSQL lifecycle Job was not claimed.");

    const activeJobs = new ControlPlaneJobService(storage, {
      now: () => new Date(now.getTime() + 10_000),
    });
    const heartbeat = await activeJobs.heartbeat(
      fixtureWorker,
      claim.lease.id,
      claim.lease.generation,
    );
    const results = new JobResultService(storage);
    const event = await results.appendEvent(
      fixtureWorker,
      claim.lease.id,
      claim.lease.generation,
      eventInput(1),
    );
    const publication = await results.publishResult(
      fixtureWorker,
      claim.lease.id,
      claim.lease.generation,
      publicationInput(1),
    );
    const completed = await new ControlPlaneJobService(storage, {
      now: () => new Date(now.getTime() + 20_000),
    }).complete(fixtureWorker, claim.lease.id, claim.lease.generation, {
      status: "completed",
      resultCompleteness: "complete",
      errorCode: null,
    });

    const persistedHeartbeat = await database!.query<{
      heartbeat_at: Date;
      heartbeat_deadline: Date;
    }>(`
      SELECT heartbeat_at, heartbeat_deadline FROM job_leases WHERE id = $1
    `, [claim.lease.id]);
    expect(heartbeat.heartbeatDeadline).toEqual(persistedHeartbeat.rows[0]?.heartbeat_deadline);
    expect(
      persistedHeartbeat.rows[0]!.heartbeat_deadline.getTime() -
        persistedHeartbeat.rows[0]!.heartbeat_at.getTime(),
    ).toBe(30_000);
    expect(event).toMatchObject({ jobId: created.id, sequence: 1, leaseGeneration: 1 });
    expect(publication).toMatchObject({
      jobId: created.id,
      sequence: 1,
      leaseGeneration: 1,
      artifact: { storage: "worker_local", objectKey: null },
    });
    expect(completed).toMatchObject({
      id: created.id,
      status: "completed",
      resultCompleteness: "complete",
    });
    const durable = await database!.query<{
      job_status: string;
      lease_status: string;
      events: string;
      publications: string;
      artifacts: string;
    }>(`
      SELECT jobs.status AS job_status, job_leases.status AS lease_status,
        (SELECT count(*) FROM job_events WHERE job_id = jobs.id) AS events,
        (SELECT count(*) FROM job_publications WHERE job_id = jobs.id) AS publications,
        (SELECT count(*) FROM artifact_metadata WHERE job_id = jobs.id) AS artifacts
      FROM jobs
      INNER JOIN job_leases ON job_leases.job_id = jobs.id
      WHERE jobs.id = $1
    `, [created.id]);
    expect(durable.rows).toEqual([{
      job_status: "completed",
      lease_status: "completed",
      events: "1",
      publications: "1",
      artifacts: "1",
    }]);
  });

  it.each([
    {
      skew: "ahead",
      applicationClockOffsetMs: 365 * 24 * 60 * 60 * 1_000,
      heartbeatDeadlineSeconds: 60,
      expectedRecovered: 0,
      expectedJobStatus: "running",
      expectedLeaseStatus: "active",
    },
    {
      skew: "behind",
      applicationClockOffsetMs: -365 * 24 * 60 * 60 * 1_000,
      heartbeatDeadlineSeconds: -1,
      expectedRecovered: 1,
      expectedJobStatus: "queued",
      expectedLeaseStatus: "expired",
    },
  ] as const)(
    "uses the PostgreSQL clock when the application clock is $skew",
    async ({
      applicationClockOffsetMs,
      heartbeatDeadlineSeconds,
      expectedRecovered,
      expectedJobStatus,
      expectedLeaseStatus,
    }) => {
      const storage = new PostgresControlPlaneDatabase(database!);
      const now = await databaseClock(database!);
      const jobs = new ControlPlaneJobService(storage, { now: () => now });
      const created = await jobs.createJob(
        fixtureProjectKey,
        `job-sweeper-clock-${expectedLeaseStatus}`,
        jobInput(`https://example.com/sweeper-clock-${expectedLeaseStatus}`),
        { correlationId: `job-sweeper-clock-${expectedLeaseStatus}` },
      );
      const claim = await jobs.claimNext(fixtureWorker);
      if (claim === null) throw new Error("The clock-skew Job was not claimed.");

      await database!.query(`
        UPDATE job_leases
        SET claimed_at = clock_timestamp() - interval '2 minutes',
          heartbeat_at = clock_timestamp() - interval '2 minutes',
          heartbeat_deadline = clock_timestamp() + make_interval(secs => $2)
        WHERE id = $1
      `, [claim.lease.id, heartbeatDeadlineSeconds]);
      const databaseNow = await databaseClock(database!);

      vi.useFakeTimers({
        now: new Date(databaseNow.getTime() + applicationClockOffsetMs),
        toFake: ["Date"],
      });
      let recovered: number;
      try {
        recovered = await new ControlPlaneJobLeaseSweeper(storage).sweep();
      } finally {
        vi.useRealTimers();
      }

      expect(recovered).toBe(expectedRecovered);
      await expect(database!.query<{ job_status: string; lease_status: string }>(`
        SELECT jobs.status AS job_status, job_leases.status AS lease_status
        FROM jobs
        INNER JOIN job_leases ON job_leases.job_id = jobs.id
        WHERE jobs.id = $1
      `, [created.id])).resolves.toMatchObject({
        rows: [{ job_status: expectedJobStatus, lease_status: expectedLeaseStatus }],
      });
    },
  );

  it("lets two sweepers recover one expired lease and fences generation one after reclaim", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => now });
    const results = new JobResultService(storage);
    const created = await jobs.createJob(
      fixtureProjectKey,
      "job-03-expire-reclaim",
      jobInput("https://example.com/expire-reclaim"),
      { correlationId: "job-03-expire-reclaim" },
    );
    const first = await jobs.claimNext(fixtureWorker);
    if (first === null) throw new Error("The first PostgreSQL generation was not claimed.");
    await database!.query(`
      UPDATE job_leases
      SET claimed_at = clock_timestamp() - interval '2 minutes',
        heartbeat_at = clock_timestamp() - interval '2 minutes',
        heartbeat_deadline = clock_timestamp() - interval '1 second'
      WHERE id = $1
    `, [first.lease.id]);

    const rendezvous = new PostgresTransactionRendezvous(database!, 2);
    const competingStorage = new RendezvousControlPlaneDatabase(
      storage,
      rendezvous,
      (statement) => statement.includes("candidates AS ("),
    );
    const sweepNow = new Date(now.getTime() + 31_000);
    const recovered = await Promise.all([
      new ControlPlaneJobLeaseSweeper(competingStorage).sweep(),
      new ControlPlaneJobLeaseSweeper(competingStorage).sweep(),
    ]);

    expectTwoBackends(rendezvous);
    expect(recovered.slice().sort((left, right) => left - right)).toEqual([0, 1]);
    const reclaimingJobs = new ControlPlaneJobService(storage, { now: () => sweepNow });
    const second = await reclaimingJobs.claimNext(fixtureWorker);
    expect(second).toMatchObject({
      job: { id: created.id, status: "running" },
      lease: { generation: 2 },
    });
    if (second === null) throw new Error("The second PostgreSQL generation was not claimed.");

    const oldGenerationJobs = new ControlPlaneJobService(storage, {
      now: () => new Date(sweepNow.getTime() + 1_000),
    });
    await expect(oldGenerationJobs.heartbeat(
      fixtureWorker,
      first.lease.id,
      first.lease.generation,
    )).rejects.toBeInstanceOf(LeaseFencedError);
    await expect(results.appendEvent(
      fixtureWorker,
      first.lease.id,
      first.lease.generation,
      eventInput(1),
    )).rejects.toBeInstanceOf(JobResultLeaseFencedError);
    await expect(results.publishResult(
      fixtureWorker,
      first.lease.id,
      first.lease.generation,
      publicationInput(1),
    )).rejects.toBeInstanceOf(JobResultLeaseFencedError);
    await expect(oldGenerationJobs.complete(
      fixtureWorker,
      first.lease.id,
      first.lease.generation,
      { status: "completed", resultCompleteness: "complete", errorCode: null },
    )).rejects.toBeInstanceOf(LeaseFencedError);

    const state = await database!.query<{
      job_status: string;
      generations: string[];
      lease_statuses: string[];
      events: string;
      publications: string;
      artifacts: string;
    }>(`
      SELECT jobs.status AS job_status,
        array_agg(job_leases.generation ORDER BY job_leases.generation) AS generations,
        array_agg(job_leases.status ORDER BY job_leases.generation) AS lease_statuses,
        (SELECT count(*) FROM job_events WHERE job_id = jobs.id) AS events,
        (SELECT count(*) FROM job_publications WHERE job_id = jobs.id) AS publications,
        (SELECT count(*) FROM artifact_metadata WHERE job_id = jobs.id) AS artifacts
      FROM jobs
      INNER JOIN job_leases ON job_leases.job_id = jobs.id
      WHERE jobs.id = $1
      GROUP BY jobs.id, jobs.status
    `, [created.id]);
    expect(state.rows).toEqual([{
      job_status: "running",
      generations: ["1", "2"],
      lease_statuses: ["expired", "active"],
      events: "0",
      publications: "0",
      artifacts: "0",
    }]);
  });

  it.each([
    { operation: "heartbeat", leaseState: "active" },
    { operation: "heartbeat", leaseState: "expired" },
    { operation: "complete", leaseState: "active" },
    { operation: "complete", leaseState: "expired" },
  ] as const)(
    "$operation and a sweep respect an $leaseState lease",
    async ({ operation, leaseState }) => {
      const storage = new PostgresControlPlaneDatabase(database!);
      const now = await databaseClock(database!);
      const jobs = new ControlPlaneJobService(storage, { now: () => now });
      const created = await jobs.createJob(
        fixtureProjectKey,
        `job-03-${operation}-sweep`,
        jobInput(`https://example.com/${operation}-sweep`),
        { correlationId: `job-03-${operation}-sweep` },
      );
      const claim = await jobs.claimNext(fixtureWorker);
      if (claim === null) throw new Error("The competing PostgreSQL Job was not claimed.");
      await database!.query(`
        UPDATE job_leases
        SET claimed_at = clock_timestamp() - interval '2 minutes',
          heartbeat_at = clock_timestamp() - interval '2 minutes',
          heartbeat_deadline = clock_timestamp() + make_interval(secs => $2)
        WHERE id = $1
      `, [claim.lease.id, leaseState === "expired" ? -1 : 60]);

      const rendezvous = new PostgresTransactionRendezvous(database!, 2);
      const competingStorage = new RendezvousControlPlaneDatabase(
        storage,
        rendezvous,
        (statement) => statement.includes("candidates AS (") ||
          (operation === "heartbeat"
            ? statement.includes("UPDATE job_leases AS leases")
            : statement.includes("UPDATE job_leases AS leases SET status = 'completed'")),
      );
      const activeJobs = new ControlPlaneJobService(competingStorage, {
        now: () => new Date(now.getTime() + 10_000),
      });
      const workerOperation = operation === "heartbeat"
        ? activeJobs.heartbeat(fixtureWorker, claim.lease.id, claim.lease.generation)
        : activeJobs.complete(fixtureWorker, claim.lease.id, claim.lease.generation, {
          status: "completed",
          resultCompleteness: "complete",
          errorCode: null,
        });
      const sweepOperation = new ControlPlaneJobLeaseSweeper(competingStorage).sweep();
      const [workerOutcome, sweepOutcome] = await Promise.allSettled([
        workerOperation,
        sweepOperation,
      ]);

      expectTwoBackends(rendezvous);
      expect(sweepOutcome).toMatchObject({ status: "fulfilled" });
      if (sweepOutcome.status !== "fulfilled") throw sweepOutcome.reason;
      if (leaseState === "active") {
        expect(workerOutcome).toMatchObject({ status: "fulfilled" });
        expect(sweepOutcome.value).toBe(0);
      } else {
        expect(workerOutcome).toMatchObject({ status: "rejected" });
        if (workerOutcome.status === "fulfilled") {
          throw new Error("An expired lease unexpectedly won the Worker operation race.");
        }
        expect(workerOutcome.reason).toBeInstanceOf(LeaseFencedError);
        expect([0, 1]).toContain(sweepOutcome.value);
        const followUpRecovered = await new ControlPlaneJobLeaseSweeper(storage).sweep();
        expect(sweepOutcome.value + followUpRecovered).toBe(1);
      }
      const state = await database!.query<{ job_status: string; lease_status: string }>(`
        SELECT jobs.status AS job_status, job_leases.status AS lease_status
        FROM jobs
        INNER JOIN job_leases ON job_leases.job_id = jobs.id
        WHERE jobs.id = $1
      `, [created.id]);
      expect(state.rows).toEqual([workerOutcome.status === "fulfilled"
        ? {
          job_status: operation === "heartbeat" ? "running" : "completed",
          lease_status: operation === "heartbeat" ? "active" : "completed",
        }
        : { job_status: "queued", lease_status: "expired" }]);
    },
  );

  it("enforces private placement and a pinned Worker during real claims", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => now });
    const privateJob = await jobs.createJob(
      fixtureProjectKey,
      "job-03-private-placement",
      privateJobInput("https://example.com/private-placement", null),
      { correlationId: "job-03-private-placement" },
    );

    await expect(jobs.claimNext(fixtureWorker)).resolves.toBeNull();
    await expect(jobs.claimNext(privateWorker)).resolves.toMatchObject({
      job: { id: privateJob.id },
      lease: { workerId: privateWorker.workerId },
    });
    await jobs.cancel(fixtureProjectKey, privateJob.id);

    const pinnedJob = await jobs.createJob(
      fixtureProjectKey,
      "job-03-pinned-placement",
      privateJobInput("https://example.com/pinned-placement", pinnedWorker.workerId),
      { correlationId: "job-03-pinned-placement" },
    );
    await expect(jobs.claimNext(privateWorker)).resolves.toBeNull();
    await expect(jobs.claimNext(pinnedWorker)).resolves.toMatchObject({
      job: { id: pinnedJob.id },
      lease: { workerId: pinnedWorker.workerId },
    });
  });

  it("serializes concurrent idempotent replays before charging creation quotas", async () => {
    const jobs = new ControlPlaneJobService(new PostgresControlPlaneDatabase(database!), {
      quotas: { ...unlimitedProjectQuotas, activeJobs: 1, monthlyProviderAttempts: 2 },
    });
    const input = jobInput("https://example.com/concurrent-quota");
    const results = await Promise.all([
      jobs.createJob(fixtureProjectKey, "concurrent-quota", input, { correlationId: "quota-a" }),
      jobs.createJob(fixtureProjectKey, "concurrent-quota", input, { correlationId: "quota-b" }),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect((await database!.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs")).rows[0]?.count).toBe("1");
  });

  it.each([-1, 1])("uses the locked database month when the app clock is %s month away", async (offset) => {
    const clock = await databaseClock(database!);
    const skewed = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth() + offset, 15));
    const jobs = new ControlPlaneJobService(new PostgresControlPlaneDatabase(database!), {
      now: () => skewed,
      quotas: { ...unlimitedProjectQuotas, monthlyProviderAttempts: 3 },
    });
    const created = await jobs.createJob(fixtureProjectKey, "database-month-first", jobInput("https://example.com/month-first"),
      { correlationId: "database-month" });
    expect(Math.abs(created.createdAt.getTime() - clock.getTime())).toBeLessThan(10_000);
    const failure = await jobs.createJob(fixtureProjectKey, "database-month-second", jobInput("https://example.com/month-second"),
      { correlationId: "database-month" }).catch((error: unknown) => error);
    const after = await databaseClock(database!);
    const nextMonth = Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, 1);
    expect(failure).toMatchObject({ code: "QUOTA_EXCEEDED", quota: "monthlyProviderAttempts" });
    const resetSeconds = (failure as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(resetSeconds).toBeGreaterThanOrEqual(Math.ceil((nextMonth - after.getTime()) / 1_000));
    expect(resetSeconds).toBeLessThanOrEqual(Math.ceil((nextMonth - clock.getTime()) / 1_000));
  });

  it("enforces Project quotas at creation without charging idempotent replays", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const jobs = new ControlPlaneJobService(storage, {
      now: () => now,
      quotas: { ...unlimitedProjectQuotas, activeJobs: 1, monthlyProviderAttempts: 3 },
    });
    const context = { correlationId: "job-quota" };
    const first = await jobs.createJob(
      fixtureProjectKey, "job-quota-first", jobInput("https://example.com/quota-1"), context,
    );
    await expect(jobs.createJob(
      fixtureProjectKey, "job-quota-first", jobInput("https://example.com/quota-1"), context,
    )).resolves.toMatchObject({ id: first.id });
    await expect(jobs.createJob(
      fixtureProjectKey, "job-quota-second", jobInput("https://example.com/quota-2"), context,
    )).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", quota: "activeJobs", limit: 1 });

    await jobs.cancel(fixtureProjectKey, first.id);
    // Two attempts are already reserved this month; another two would exceed the limit of three.
    await expect(jobs.createJob(
      fixtureProjectKey, "job-quota-third", jobInput("https://example.com/quota-3"), context,
    )).rejects.toMatchObject({ quota: "monthlyProviderAttempts", limit: 3 });
    const counted = await database!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE project_id = $1",
      [fixtureProjectKey.projectId],
    );
    expect(counted.rows[0]?.count).toBe("1");
  });
});
