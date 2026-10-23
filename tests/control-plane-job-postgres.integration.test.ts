import { randomBytes, randomUUID } from "node:crypto";

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
import { enforceJobCreationQuotas, unlimitedProjectQuotas } from "../src/control-plane/quotas.js";
import {
  WebhookDispatcher,
  WebhookSecretCipher,
  WebhookService,
} from "../src/control-plane/webhooks.js";
import { verifyWebhook } from "../src/sdk/webhooks.js";
import {
  configuredDatabaseUrl,
  databaseClock,
  databaseUrl,
  eventInput,
  fixture,
  fixtureCapabilityHash,
  fixtureNow,
  fixtureProjectKey,
  fixtureWorker,
  jobInput,
  pinnedCapabilityHash,
  pinnedWorker,
  privateCapabilityHash,
  privateJobInput,
  privateWorker,
  publicationInput,
  quotedTestDatabase,
  requiredDatabaseUrl,
  seedRuntimeFixture,
} from "./control-plane-job-fixture.js";

const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;
import { PostgresControlPlaneDatabase } from "../src/server.js";

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

  it("replays a scheduled Job after waiting past notBefore under the Project lock", async () => {
    const jobs = new ControlPlaneJobService(new PostgresControlPlaneDatabase(database!), {
      quotas: { ...unlimitedProjectQuotas, activeJobs: 1 },
    });
    const input = { ...jobInput("https://example.com/scheduled-replay"),
      notBefore: new Date((await databaseClock(database!)).getTime() + 1_500) };
    const first = await jobs.createJob(fixtureProjectKey, "scheduled-replay", input, { correlationId: "scheduled-first" });
    const blocker = await database!.connect();
    let replay: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('diaoyan-project-quota:' || $1::text, 0))",
        [fixtureProjectKey.projectId]);
      replay = jobs.createJob(fixtureProjectKey, "scheduled-replay", input,
        { correlationId: "scheduled-repeat" }).catch((error: unknown) => error);
      await vi.waitFor(async () => {
        const waiting = await blocker.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        expect(waiting.rows).toHaveLength(1);
      }, { timeout: 1_000, interval: 20 });
      await blocker.query("SELECT pg_sleep(GREATEST(0, extract(epoch FROM ($1::timestamptz - clock_timestamp()))) + 0.05)",
        [input.notBefore]);
      await blocker.query("COMMIT");
      expect(await replay).toMatchObject({ id: first.id, notBefore: first.notBefore });
      await expect(jobs.createJob(fixtureProjectKey, "scheduled-replay", {
        ...jobInput("https://example.com/different"), notBefore: input.notBefore,
      }, { correlationId: "scheduled-conflict" })).rejects.toMatchObject({ code: "JOB_IDEMPOTENCY_CONFLICT" });
      await expect(jobs.createJob(fixtureProjectKey, "new-past-schedule", input,
        { correlationId: "scheduled-new" })).rejects.toThrow("at or after creation");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await replay;
    }
  });

  it("plans no disabled usage scans when only activeJobs is enabled", async () => {
    await new ControlPlaneJobService(new PostgresControlPlaneDatabase(database!)).createJob(
      fixtureProjectKey, "usage-plan", jobInput("https://example.com/usage-plan"), { correlationId: "usage-plan" });
    type UsagePlan = { "Node Type": string; "Relation Name"?: string; Output?: string[]; Plans?: UsagePlan[] };
    let plan: UsagePlan | undefined;
    let usage: unknown;
    await enforceJobCreationQuotas({
      query: async <Row>(sql: string, parameters: readonly unknown[]) => {
        const explanation = await database!.query(`EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${sql}`, [...parameters]);
        plan = explanation.rows[0]?.["QUERY PLAN"][0].Plan as UsagePlan;
        const result = await database!.query(sql, [...parameters]);
        usage = result.rows[0];
        return { rows: result.rows as Row[] };
      },
    }, fixtureProjectKey.projectId, { maxProviderAttempts: 1, maxBrowserMs: 1 },
    { ...unlimitedProjectQuotas, activeJobs: 10 }, await databaseClock(database!));
    expect(usage).toEqual({ active_jobs: "1", reserved_provider_attempts: "0", reserved_browser_ms: "0", artifact_bytes: "0" });
    const nodes = [plan!];
    const relations: string[] = [];
    const aggregates: string[][] = [];
    while (nodes.length > 0) {
      const node = nodes.pop()!;
      if (node["Relation Name"] !== undefined) relations.push(node["Relation Name"]);
      if (node["Node Type"] === "Aggregate") aggregates.push(node.Output ?? []);
      nodes.push(...(node.Plans ?? []));
    }
    expect(relations).toEqual(["jobs"]);
    expect(aggregates).toEqual([["count(*)"]]);
    expect(plan?.Output?.slice(1)).toEqual(["'0'::text", "'0'::text", "'0'::text"]);
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

  it.each(["monthlyProviderAttempts", "monthlyBrowserMs"] as const)(
    "excludes future-created reservations from the current %s window", async (quota) => {
      const storage = new PostgresControlPlaneDatabase(database!);
      const input = { ...jobInput("https://example.com/future-reservation"),
        budget: { ...jobInput("https://example.com/future-reservation").budget, maxBrowserMs: 1_000 } };
      const future = await new ControlPlaneJobService(storage).createJob(fixtureProjectKey, "future-budget", input,
        { correlationId: "future-budget" });
      const clock = await databaseClock(database!);
      const nextMonthStart = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth() + 1, 1));
      await database!.query(`UPDATE jobs SET created_at = $2, updated_at = $2, not_before = $2,
        deadline_at = $2::timestamptz + interval '5 minutes' WHERE id = $1`, [future.id, nextMonthStart]);
      const quotas = { ...unlimitedProjectQuotas, [quota]: quota === "monthlyProviderAttempts" ? 3 : 1_500 };
      const jobs = new ControlPlaneJobService(storage, { quotas });
      await expect(jobs.createJob(fixtureProjectKey, "current-budget", input,
        { correlationId: "current-budget" })).resolves.toMatchObject({ status: "queued" });
      // The current-month reservation still counts; the next-month row was excluded, not waived forever.
      await expect(jobs.createJob(fixtureProjectKey, "excess-current-budget", input,
        { correlationId: "excess-current-budget" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", quota });
      // Query the next UTC window explicitly: only the future row should count there.
      await storage.transaction(async (transaction) => {
        await transaction.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('diaoyan-project-quota:' || $1::text, 0))",
          [fixtureProjectKey.projectId],
        );
        await expect(enforceJobCreationQuotas(transaction, fixtureProjectKey.projectId,
          { maxProviderAttempts: 1, maxBrowserMs: 500 }, quotas, nextMonthStart)).resolves.toBeUndefined();
        await expect(enforceJobCreationQuotas(transaction, fixtureProjectKey.projectId,
          input.budget, quotas, nextMonthStart)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", quota });
      });
    },
  );

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

  it("records terminal Job events, signs deliveries, retries, and dead-letters disabled endpoints", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const cipher = WebhookSecretCipher.fromKey(randomBytes(32));
    const urlPolicy = { parse: (input: string) => new URL(input), assertPublic: async () => [] };
    const webhooks = new WebhookService(storage, cipher, urlPolicy);
    const { endpoint, secret } = await webhooks.createEndpoint(fixtureProjectKey, {
      url: "https://hooks.example.com/crawlume",
      eventTypes: ["job.cancelled"],
    });
    const received: Array<{ headers: Record<string, string>; body: string }> = [];
    const statuses = [500, 200];
    const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
      received.push({ headers: init?.headers as Record<string, string>, body: init?.body as string });
      return new Response(null, { status: statuses.shift() ?? 200 });
    }) as typeof fetch;
    const dispatcher = new WebhookDispatcher(storage, cipher, urlPolicy, { fetch: fakeFetch, retryBaseMs: 0 });

    const jobs = new ControlPlaneJobService(storage, { now: () => now });
    const context = { correlationId: "job-webhook" };
    const job = await jobs.createJob(fixtureProjectKey, "job-webhook", jobInput("https://example.com/hook"), context);
    await jobs.cancel(fixtureProjectKey, job.id);
    await jobs.cancel(fixtureProjectKey, job.id);
    const events = await database!.query<{ id: string; event_type: string }>(
      "SELECT id, event_type FROM webhook_events WHERE job_id = $1", [job.id],
    );
    expect(events.rows).toEqual([{ id: expect.any(String), event_type: "job.cancelled" }]);

    await expect(dispatcher.sweep()).resolves.toBe(1);
    await expect(dispatcher.sweep()).resolves.toBe(1);
    await expect(dispatcher.sweep()).resolves.toBe(0);
    expect(received).toHaveLength(2);
    const delivered = verifyWebhook({ secrets: secret, headers: received[1]!.headers, body: received[1]!.body });
    expect(delivered).toMatchObject({
      id: events.rows[0]!.id,
      type: "job.cancelled",
      data: { job_id: job.id, project_id: fixture.projectId, status: "cancelled" },
    });
    const [delivery] = await webhooks.listDeliveries(fixtureProjectKey, 10);
    expect(delivery).toMatchObject({ endpointId: endpoint.id, status: "succeeded", attemptCount: 2, lastStatusCode: 200 });
    const attempts = await database!.query<{ attempt: number; status_code: number }>(
      "SELECT attempt, status_code FROM webhook_delivery_attempts ORDER BY attempt",
    );
    expect(attempts.rows).toEqual([{ attempt: 1, status_code: 500 }, { attempt: 2, status_code: 200 }]);

    const rotated = await webhooks.rotateSecret(fixtureProjectKey, endpoint.id);
    await expect(webhooks.redeliver(fixtureProjectKey, events.rows[0]!.id)).resolves.toBe(1);
    await dispatcher.sweep();
    const redelivered = received[2]!;
    expect(verifyWebhook({ secrets: rotated, headers: redelivered.headers, body: redelivered.body }).id)
      .toBe(events.rows[0]!.id);
    expect(verifyWebhook({ secrets: secret, headers: redelivered.headers, body: redelivered.body }).id)
      .toBe(events.rows[0]!.id);

    await webhooks.redeliver(fixtureProjectKey, events.rows[0]!.id);
    await webhooks.disableEndpoint(fixtureProjectKey, endpoint.id);
    await dispatcher.sweep();
    expect(received).toHaveLength(3);
    const [latest] = await webhooks.listDeliveries(fixtureProjectKey, 1);
    expect(latest).toMatchObject({ status: "dead_letter", lastError: "The endpoint is disabled." });
    await expect(webhooks.listEndpoints(fixtureProjectKey)).resolves.toMatchObject([{ status: "disabled" }]);
  });
});
