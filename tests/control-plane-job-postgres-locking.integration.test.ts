import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
import { PostgresControlPlaneDatabase } from "../src/server.js";

const configuredDatabaseUrl = process.env.DIAOYAN_TEST_POSTGRES_URL;
const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;
const applicationName = "diaoyan-job-03-locking";

const fixture = Object.freeze({
  userId: "00000000-0000-4000-8000-000000002001",
  organizationId: "00000000-0000-4000-8000-000000002101",
  projectId: "00000000-0000-4000-8000-000000002201",
  workerId: "00000000-0000-4000-8000-000000002401",
  publicKeyId: "00000000-0000-4000-8000-000000002402",
  sessionId: "00000000-0000-4000-8000-000000002403",
  apiKeyId: "00000000-0000-4000-8000-000000002501",
});
const capabilityHash = Buffer.alloc(32, 31);
const worker: AuthenticatedWorker = Object.freeze({
  workerId: fixture.workerId,
  projectId: fixture.projectId,
  sessionId: fixture.sessionId,
  capabilityHash: capabilityHash.toString("base64url"),
});
const projectKey: AuthenticatedProjectApiKey = Object.freeze({
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
  url.searchParams.set("application_name", applicationName);
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
    policyVersion: "job-03-locking-v1",
    uploadPrivateArtifact: false,
  });
}

function eventInput(): JobEventInput {
  return Object.freeze({
    localSequence: 1,
    eventType: "page-fetched",
    pageStatus: 200,
    errorCode: null,
    provider: "http",
    byteCount: 512,
    durationMs: 10,
    contentHash: Buffer.alloc(32, 32).toString("base64url"),
    usage: Object.freeze({ requests: 1 }),
    occurredAt: new Date("2030-01-01T00:00:00.000Z"),
  });
}

function publicationInput(): PublishJobResultInput {
  return Object.freeze({
    localSequence: 1,
    contentHash: Buffer.alloc(32, 33).toString("base64url"),
    byteCount: 1_024,
    mediaType: "text/markdown",
    completeness: "complete" as const,
    storage: "worker_local" as const,
  });
}

async function seedRuntimeFixture(database: Pool): Promise<void> {
  await database.query(`
    INSERT INTO users(id, oidc_issuer, oidc_subject)
    VALUES ($1, $2, $3)
  `, [fixture.userId, "https://issuer.example", "job-03-locking-user"]);
  await database.query(`
    INSERT INTO organizations(id, slug, name, kind)
    VALUES ($1, $2, $3, 'business')
  `, [fixture.organizationId, "job-03-locking", "JOB-03 Locking"]);
  await database.query(`
    INSERT INTO projects(id, organization_id, slug, name)
    VALUES ($1, $2, $3, $4)
  `, [fixture.projectId, fixture.organizationId, "job-03-locking", "JOB-03 Locking"]);
  await database.query(`
    INSERT INTO workers(
      id, project_id, name, kind, version, capability_manifest,
      capability_hash, created_by_user_id
    ) VALUES ($1, $2, $3, 'public', $4, $5::jsonb, $6, $7)
  `, [
    fixture.workerId,
    fixture.projectId,
    "job-03-locking-worker",
    "1.0.0",
    JSON.stringify({ http: true }),
    capabilityHash,
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
    Buffer.from("job-03-locking-key"),
    Buffer.alloc(32, 34),
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
    capabilityHash,
    new Date("2031-01-01T00:00:00.000Z"),
  ]);
}

async function databaseClock(database: Pool): Promise<Date> {
  const result = await database.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new Error("PostgreSQL did not return its current clock.");
  return now;
}

async function waitUntilDatabaseTime(database: Pool, deadline: Date): Promise<void> {
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    const result = await database.query<{ reached: boolean }>(`
      SELECT clock_timestamp() >= $1 AS reached
    `, [deadline]);
    if (result.rows[0]?.reached === true) return;
  }
  throw new Error("PostgreSQL did not reach the fenced lease deadline.");
}

async function waitForBlockedStatements(
  database: Pool,
  statementFragment: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const result = await database.query<{ waiting: string }>(`
      SELECT count(*) AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = $1
        AND query LIKE $2
        AND wait_event_type = 'Lock'
        AND cardinality(pg_blocking_pids(pid)) > 0
    `, [applicationName, `%${statementFragment}%`]);
    if (Number(result.rows[0]?.waiting) === expected) return;
  }
  throw new Error(`Expected ${expected} PostgreSQL statement(s) to wait on a row lock.`);
}

async function installJobUpdateGate(database: Pool, jobId: string, gate: number): Promise<void> {
  await database.query(`
    CREATE TABLE job_03_update_gates(job_id UUID PRIMARY KEY, gate INTEGER NOT NULL);
    CREATE FUNCTION job_03_wait_on_job_update() RETURNS trigger AS $$
    DECLARE selected_gate INTEGER;
    BEGIN
      SELECT gate INTO selected_gate FROM job_03_update_gates WHERE job_id = NEW.id;
      IF selected_gate IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(9303, selected_gate);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER job_03_gate_job_update
      BEFORE UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION job_03_wait_on_job_update();
  `);
  await database.query(
    "INSERT INTO job_03_update_gates(job_id, gate) VALUES ($1, $2)",
    [jobId, gate],
  );
}

async function waitForAdvisoryWaiter(database: Pool, gate: number): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const result = await database.query<{ waiting: boolean }>(`
      SELECT EXISTS(
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 9303 AND objid = $1
          AND granted = FALSE
      ) AS waiting
    `, [gate]);
    if (result.rows[0]?.waiting === true) return;
  }
  throw new Error("The PostgreSQL operation did not reach its advisory gate.");
}

async function waitForSweepBlock(
  database: Pool,
  signal: AbortSignal,
): Promise<"blocked" | "aborted"> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (signal.aborted) return "aborted";
    const result = await database.query<{ waiting: boolean }>(`
      SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND query LIKE '%WITH candidates AS (%'
          AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0
      ) AS waiting
    `, [applicationName]);
    if (result.rows[0]?.waiting === true) return "blocked";
  }
  if (signal.aborted) return "aborted";
  throw new Error("The lease sweep neither settled nor reached the expected PostgreSQL lock.");
}

class AdvisoryGateDatabase implements ControlPlaneDatabase {
  constructor(
    private readonly delegate: ControlPlaneDatabase,
    private readonly gate: number,
  ) {}

  query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    return this.delegate.query<Row>(statement, parameters);
  }

  transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    return this.delegate.transaction(async (transaction) => {
      let gated = false;
      const controlled: ControlPlaneQuery = {
        query: async <Row>(statement: string, parameters: readonly unknown[]) => {
          if (!gated && statement.includes("FOR UPDATE OF jobs SKIP LOCKED")) {
            gated = true;
            await transaction.query("SELECT pg_advisory_xact_lock(9303, $1)", [this.gate]);
          }
          return transaction.query<Row>(statement, parameters);
        },
      };
      return operation(controlled);
    });
  }
}

function postgresCode(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== "rejected" || typeof result.reason !== "object" || result.reason === null) {
    return undefined;
  }
  return "code" in result.reason && typeof result.reason.code === "string"
    ? result.reason.code
    : undefined;
}

describeWithPostgres("control-plane Job PostgreSQL lock and clock fencing", () => {
  let administration: Pool;
  let database: Pool | undefined;
  let monitor: Pool | undefined;
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
    monitor = new Pool({ connectionString, max: 3 });
    await database.query("SELECT 1");
    await monitor.query("SELECT 1");
    await runControlPlaneMigrations(database);
    await seedRuntimeFixture(database);
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    for (const pool of [database, monitor]) {
      try {
        await pool?.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    database = undefined;
    monitor = undefined;
    if (databaseName !== undefined) {
      try {
        await administration.query(`DROP DATABASE ${quotedTestDatabase(databaseName)}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
      databaseName = undefined;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "PostgreSQL locking test cleanup failed.");
    }
  });

  afterAll(async () => {
    await administration.end();
  });

  it.each(["pause", "cancel"] as const)(
    "%s and an expired-lease sweep finish without a lock-order deadlock",
    async (transition) => {
      const storage = new PostgresControlPlaneDatabase(database!);
      const now = await databaseClock(monitor!);
      const jobs = new ControlPlaneJobService(storage, { now: () => now });
      const created = await jobs.createJob(
        projectKey,
        `job-03-${transition}-sweep`,
        jobInput(`https://example.com/${transition}-sweep`),
        { correlationId: `job-03-${transition}-sweep` },
      );
      const claim = await jobs.claimNext(worker);
      if (claim === null) throw new Error("The PostgreSQL Job was not claimed.");

      const gate = transition === "pause" ? 1 : 2;
      await installJobUpdateGate(database!, created.id, gate);
      const blocker: PoolClient = await monitor!.connect();
      let unlocked = false;
      try {
        await blocker.query("SELECT pg_advisory_lock(9303, $1)", [gate]);
        const transitionOperation = transition === "pause"
          ? jobs.pause(projectKey, created.id)
          : jobs.cancel(projectKey, created.id);
        await waitForAdvisoryWaiter(monitor!, gate);

        const sweepOperation = new ControlPlaneJobLeaseSweeper(storage, {
          now: () => new Date(now.getTime() + 31_000),
        }).sweep();
        const observationController = new AbortController();
        const sweepBlocked = waitForSweepBlock(monitor!, observationController.signal);
        await Promise.race([sweepOperation.then(() => "settled" as const), sweepBlocked]);
        observationController.abort();
        await blocker.query("SELECT pg_advisory_unlock(9303, $1)", [gate]);
        unlocked = true;

        const outcomes = await Promise.allSettled([transitionOperation, sweepOperation]);
        await sweepBlocked;
        expect(outcomes.map(postgresCode)).not.toContain("40P01");
        expect(outcomes[0]).toMatchObject({ status: "fulfilled" });
        expect(await jobs.getJob(projectKey, created.id)).toMatchObject({
          status: transition === "pause" ? "paused" : "cancelled",
        });
        await expect(database!.query<{ active: string }>(`
          SELECT count(*) AS active FROM job_leases
          WHERE job_id = $1 AND status = 'active'
        `, [created.id])).resolves.toMatchObject({ rows: [{ active: "0" }] });
      } finally {
        if (!unlocked) await blocker.query("SELECT pg_advisory_unlock_all()");
        blocker.release();
      }
    },
  );

  it.each(["heartbeat", "complete"] as const)(
    "%s rechecks the database clock after waiting past the heartbeat deadline",
    async (operation) => {
      const storage = new PostgresControlPlaneDatabase(database!);
      const start = await databaseClock(monitor!);
      const jobs = new ControlPlaneJobService(storage, { now: () => start });
      await jobs.createJob(
        projectKey,
        `job-03-stale-${operation}`,
        jobInput(`https://example.com/stale-${operation}`),
        { correlationId: `job-03-stale-${operation}` },
      );
      const claim = await jobs.claimNext(worker);
      if (claim === null) throw new Error("The clock-fencing Job was not claimed.");

      const blocker = await monitor!.connect();
      let transactionOpen = false;
      try {
        await blocker.query("BEGIN");
        transactionOpen = true;
        const deadlineResult = await blocker.query<{ deadline: Date }>(`
          UPDATE job_leases
          SET heartbeat_deadline = clock_timestamp() + interval '2 seconds'
          WHERE id = $1
          RETURNING heartbeat_deadline AS deadline
        `, [claim.lease.id]);
        const deadline = deadlineResult.rows[0]?.deadline;
        if (!(deadline instanceof Date)) throw new Error("The lease deadline was not returned.");
        expect((await databaseClock(monitor!)).getTime()).toBeLessThan(deadline.getTime());

        const staleNow = new Date(deadline.getTime() - 1);
        const staleJobs = new ControlPlaneJobService(storage, { now: () => staleNow });
        const workerOperation = operation === "heartbeat"
          ? staleJobs.heartbeat(worker, claim.lease.id, claim.lease.generation)
          : staleJobs.complete(worker, claim.lease.id, claim.lease.generation, {
            status: "completed",
            resultCompleteness: "complete",
            errorCode: null,
          });
        await waitForBlockedStatements(
          monitor!,
          "SELECT id FROM job_leases",
          1,
        );
        await waitUntilDatabaseTime(monitor!, deadline);
        await blocker.query("COMMIT");
        transactionOpen = false;

        await expect(workerOperation).rejects.toBeInstanceOf(LeaseFencedError);
        await expect(database!.query<{ job_status: string; lease_status: string }>(`
          SELECT jobs.status AS job_status, job_leases.status AS lease_status
          FROM jobs INNER JOIN job_leases ON job_leases.job_id = jobs.id
          WHERE jobs.id = $1
        `, [claim.job.id])).resolves.toMatchObject({
          rows: [{ job_status: "running", lease_status: "active" }],
        });
      } finally {
        if (transactionOpen) await blocker.query("ROLLBACK");
        blocker.release();
      }
    },
  );

  it("fences event and publication writes that wait past the heartbeat deadline", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const start = await databaseClock(monitor!);
    const jobs = new ControlPlaneJobService(storage, { now: () => start });
    await jobs.createJob(
      projectKey,
      "job-03-stale-results",
      jobInput("https://example.com/stale-results"),
      { correlationId: "job-03-stale-results" },
    );
    const claim = await jobs.claimNext(worker);
    if (claim === null) throw new Error("The result clock-fencing Job was not claimed.");

    const blocker = await monitor!.connect();
    let transactionOpen = false;
    try {
      await blocker.query("BEGIN");
      transactionOpen = true;
      const deadlineResult = await blocker.query<{ deadline: Date }>(`
        UPDATE job_leases
        SET heartbeat_deadline = clock_timestamp() + interval '2 seconds'
        WHERE id = $1
        RETURNING heartbeat_deadline AS deadline
      `, [claim.lease.id]);
      await blocker.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [claim.job.id]);
      const deadline = deadlineResult.rows[0]?.deadline;
      if (!(deadline instanceof Date)) throw new Error("The result deadline was not returned.");

      const results = new JobResultService(storage);
      const eventOperation = results.appendEvent(
        worker, claim.lease.id, claim.lease.generation, eventInput(),
      );
      const publicationOperation = results.publishResult(
        worker, claim.lease.id, claim.lease.generation, publicationInput(),
      );
      const resultOutcomes = Promise.allSettled([eventOperation, publicationOperation]);
      await waitForBlockedStatements(monitor!, "SELECT job_id FROM job_leases", 2);
      await waitUntilDatabaseTime(monitor!, deadline);
      await blocker.query("COMMIT");
      transactionOpen = false;

      const outcomes = await resultOutcomes;
      expect(outcomes).toHaveLength(2);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ status: "rejected" });
        if (outcome.status === "rejected") {
          expect(outcome.reason).toBeInstanceOf(JobResultLeaseFencedError);
        }
      }
      await expect(database!.query<{ events: string; publications: string; artifacts: string }>(`
        SELECT
          (SELECT count(*) FROM job_events WHERE job_id = $1) AS events,
          (SELECT count(*) FROM job_publications WHERE job_id = $1) AS publications,
          (SELECT count(*) FROM artifact_metadata WHERE job_id = $1) AS artifacts
      `, [claim.job.id])).resolves.toMatchObject({
        rows: [{ events: "0", publications: "0", artifacts: "0" }],
      });
    } finally {
      if (transactionOpen) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("rechecks Job deadline eligibility after claim waits on an advisory gate", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const start = await databaseClock(monitor!);
    const jobs = new ControlPlaneJobService(storage, { now: () => start });
    const created = await jobs.createJob(
      projectKey,
      "job-03-stale-claim",
      jobInput("https://example.com/stale-claim"),
      { correlationId: "job-03-stale-claim" },
    );
    const deadlineResult = await database!.query<{ deadline: Date }>(`
      UPDATE jobs SET deadline_at = clock_timestamp() + interval '2 seconds'
      WHERE id = $1 RETURNING deadline_at AS deadline
    `, [created.id]);
    const deadline = deadlineResult.rows[0]?.deadline;
    if (!(deadline instanceof Date)) throw new Error("The Job deadline was not returned.");

    const gate = 3;
    const blocker = await monitor!.connect();
    let unlocked = false;
    try {
      await blocker.query("SELECT pg_advisory_lock(9303, $1)", [gate]);
      const staleJobs = new ControlPlaneJobService(
        new AdvisoryGateDatabase(storage, gate),
        { now: () => new Date(deadline.getTime() - 1) },
      );
      const claimOperation = staleJobs.claimNext(worker);
      await waitForAdvisoryWaiter(monitor!, gate);
      await waitUntilDatabaseTime(monitor!, deadline);
      await blocker.query("SELECT pg_advisory_unlock(9303, $1)", [gate]);
      unlocked = true;

      await expect(claimOperation).resolves.toBeNull();
      await expect(database!.query<{ leases: string }>(`
        SELECT count(*) AS leases FROM job_leases WHERE job_id = $1
      `, [created.id])).resolves.toMatchObject({ rows: [{ leases: "0" }] });
    } finally {
      if (!unlocked) await blocker.query("SELECT pg_advisory_unlock_all()");
      blocker.release();
    }
  });
});
