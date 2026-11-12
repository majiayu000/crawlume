import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { JobScheduleService } from "../src/control-plane/job-schedules.js";
import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";
import { JobResultService } from "../src/control-plane/organization-authorization.js";
import { ControlPlaneJobService } from "../src/control-plane/project-scope.js";
import {
  DatasetNotFoundError,
  DatasetService,
  KeyValueRecordNotFoundError,
  KeyValueRecordTooLargeError,
  KeyValueStoreNotFoundError,
  KeyValueStoreService,
} from "../src/control-plane/project-storage.js";
import { PostgresControlPlaneDatabase } from "../src/server.js";
import {
  configuredDatabaseUrl,
  databaseUrl,
  fixture,
  fixtureProjectKey,
  fixtureWorker,
  jobInput,
  publicationInput,
  quotedTestDatabase,
  requiredDatabaseUrl,
  seedRuntimeFixture,
} from "./control-plane-job-fixture.js";
import { trackPoolErrors } from "./helpers.js";

const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;
const otherProjectId = "00000000-0000-4000-8000-000000001202";
const otherProject = { projectId: otherProjectId };
const project = { projectId: fixture.projectId };
const scheduledJob = {
  type: "read",
  input: { url: "https://example.com/scheduled" },
  data_class: "public",
  placement: { class: "public", pinned_worker_id: null },
  required_capabilities: { http: true },
  budget: {
    deadline_ms: 300_000, max_provider_attempts: 2, max_document_bytes: 1_000_000,
    max_browser_ms: 0, max_browser_contexts: 0,
  },
  policy_version: "schedule-v1",
  upload_private_artifact: false,
  dataset: "nightly",
};

describeWithPostgres("Project storage and Job schedules on PostgreSQL", () => {
  let administration: Pool;
  let pools: Pool[] = [];
  let databaseName: string | undefined;
  const unexpectedPoolErrors: unknown[] = [];

  function connect(): PostgresControlPlaneDatabase {
    const pool = trackPoolErrors(new Pool({ connectionString: databaseUrl(databaseName!), max: 4 }), unexpectedPoolErrors);
    pools.push(pool);
    return new PostgresControlPlaneDatabase(pool);
  }

  beforeAll(async () => {
    administration = new Pool({ connectionString: requiredDatabaseUrl(), max: 1 });
    await administration.query("SELECT 1");
  });

  beforeEach(async () => {
    databaseName = `diaoyan_test_${randomUUID().replaceAll("-", "")}`;
    await administration.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
    const database = connect();
    await runControlPlaneMigrations(database);
    await seedRuntimeFixture(pools[0]!);
    await pools[0]!.query(`
      INSERT INTO projects(id, organization_id, slug, name) VALUES ($1, $2, 'other-project', 'Other Project')
    `, [otherProjectId, fixture.organizationId]);
  });

  afterEach(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    pools = [];
    if (databaseName !== undefined) {
      await administration.query(`DROP DATABASE ${quotedTestDatabase(databaseName)} WITH (FORCE)`);
      databaseName = undefined;
    }
    expect(unexpectedPoolErrors.splice(0)).toEqual([]);
  });

  afterAll(async () => {
    await administration.end();
  });

  it("keeps datasets of the same name separate per Project and numbers items contiguously", async () => {
    const datasets = new DatasetService(connect());
    await Promise.all([
      datasets.append(project, "results", [{ n: 1 }, { n: 2 }]),
      datasets.append(project, "results", [{ n: 3 }]),
      datasets.append(otherProject, "results", [{ secret: true }]),
    ]);

    const mine = await datasets.listItems(project, "results", { offset: 0, limit: 100 });
    expect(mine.dataset.itemCount).toBe(3);
    expect(mine.items.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(mine.items.map(({ item }) => item.n).sort()).toEqual([1, 2, 3]);
    expect((await datasets.listItems(project, "results", { offset: 2, limit: 100 })).items).toHaveLength(1);
    expect((await datasets.listItems(otherProject, "results", { offset: 0, limit: 100 })).items.map(({ item }) => item))
      .toEqual([{ secret: true }]);
    expect((await datasets.list(project, { after: null, limit: 10 })).map(({ id }) => id))
      .not.toContain((await datasets.get(otherProject, "results")).id);
    await expect(datasets.get(project, "missing")).rejects.toBeInstanceOf(DatasetNotFoundError);
  });

  it("isolates key-value stores per Project and enforces the record size limit", async () => {
    const stores = new KeyValueStoreService(connect(), { maxRecordBytes: 4 });
    await stores.put(project, "state", "INPUT", { contentType: "application/json", value: Buffer.from("{}") });
    await stores.put(project, "state", "INPUT", { contentType: "image/png", value: Buffer.from([0, 1, 2]) });

    expect(await stores.get(project, "state", "INPUT")).toMatchObject({
      contentType: "image/png", byteCount: 3, value: Buffer.from([0, 1, 2]),
    });
    await expect(stores.get(otherProject, "state", "INPUT")).rejects.toBeInstanceOf(KeyValueStoreNotFoundError);
    await expect(stores.delete(otherProject, "state", "INPUT")).rejects.toBeInstanceOf(KeyValueStoreNotFoundError);
    await expect(stores.put(project, "state", "BIG", { contentType: "text/plain", value: Buffer.alloc(5) }))
      .rejects.toBeInstanceOf(KeyValueRecordTooLargeError);
    expect((await stores.listKeys(project, "state", { after: null, limit: 10 })).map(({ key }) => key))
      .toEqual(["INPUT"]);
    await stores.delete(project, "state", "INPUT");
    await expect(stores.get(project, "state", "INPUT")).rejects.toBeInstanceOf(KeyValueRecordNotFoundError);
  });

  it("appends one result item to a Job's output dataset when it completes", async () => {
    const database = connect();
    const jobs = new ControlPlaneJobService(database);
    const job = await jobs.createJob(fixtureProjectKey, "dataset-job", {
      ...jobInput("https://example.com/page"), dataset: "pages",
    }, { correlationId: "dataset-job" });
    expect(job.datasetId).not.toBeNull();
    const claim = await jobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("The dataset Job was not claimed.");
    const lease = [fixtureWorker, claim.lease.id, claim.lease.generation] as const;
    const published = await new JobResultService(database).publishResult(...lease, publicationInput(1));
    await jobs.complete(...lease, { status: "completed", resultCompleteness: "complete", errorCode: null });

    const page = await new DatasetService(database).listItems(project, "pages", { offset: 0, limit: 10 });
    expect(page.items.map(({ item }) => item)).toEqual([{
      job_id: job.id,
      type: "read",
      url: "https://example.com/page",
      result_completeness: "complete",
      completed_at: expect.any(String),
      http_status: null,
      artifact: {
        id: published.artifact.id, media_type: "text/markdown", byte_count: 2_048,
        content_hash: published.artifact.contentHash, storage: "worker_local",
      },
    }]);
  });

  it("fires each schedule slot once across concurrent control-plane instances", async () => {
    const instances = [connect(), connect(), connect()].map((database) =>
      new JobScheduleService(database, new ControlPlaneJobService(database)));
    const schedule = await instances[0]!.create(fixtureProjectKey, {
      name: "nightly", cron: "* * * * *", jobRequest: scheduledJob, enabled: true,
    });
    await expect(instances[0]!.list(otherProject)).resolves.toEqual([]);
    const slot = new Date(Date.now() - 120_000);
    slot.setUTCSeconds(0, 0);
    await pools[0]!.query("UPDATE job_schedules SET next_fire_at = $2 WHERE id = $1", [schedule.id, slot]);

    const fired = await Promise.all(instances.map((instance) => instance.sweep()));
    expect(fired.reduce((sum, count) => sum + count, 0)).toBe(1);
    // An instance that re-reads the same slot (e.g. after a lost commit acknowledgement) replays the Job.
    await pools[0]!.query("UPDATE job_schedules SET next_fire_at = $2 WHERE id = $1", [schedule.id, slot]);
    await Promise.all(instances.map((instance) => instance.sweep()));

    const created = await pools[0]!.query<{ id: string; idempotency_key: string; dataset_id: string }>(
      "SELECT id, idempotency_key, dataset_id FROM jobs WHERE project_id = $1", [fixture.projectId],
    );
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]?.idempotency_key).toBe(`schedule:${schedule.id}:${slot.toISOString()}`);
    const after = await instances[0]!.get(project, schedule.id);
    expect(after.lastJobId).toBe(created.rows[0]?.id);
    expect(after.lastErrorCode).toBeNull();
    // Missed slots are skipped: the next firing is in the future, not the minute after the old slot.
    expect(after.nextFireAt.getTime()).toBeGreaterThan(Date.now());
    expect(created.rows[0]?.dataset_id).toBe((await new DatasetService(connect()).get(project, "nightly")).id);
  });

  it("does not fire disabled schedules and records failed firings without stopping", async () => {
    const database = connect();
    const schedules = new JobScheduleService(database, new ControlPlaneJobService(database));
    const disabled = await schedules.create(fixtureProjectKey, {
      name: "paused", cron: "* * * * *", jobRequest: scheduledJob, enabled: false,
    });
    const failing = await schedules.create(fixtureProjectKey, {
      name: "failing", cron: "* * * * *", jobRequest: scheduledJob, enabled: true,
    });
    const past = new Date(Date.now() - 60_000);
    await pools[0]!.query("UPDATE job_schedules SET next_fire_at = $1", [past]);
    // Make the stored request invalid for Job creation so the firing fails inside its savepoint.
    await pools[0]!.query(
      "UPDATE job_schedules SET job_request = job_request || '{\"policy_version\": \" \"}' WHERE id = $1",
      [failing.id],
    );

    expect(await schedules.sweep()).toBe(1);
    expect((await pools[0]!.query("SELECT id FROM jobs")).rows).toEqual([]);
    const failed = await schedules.get(project, failing.id);
    expect(failed.lastErrorCode).toBe("JOB_CREATION_FAILED");
    expect(failed.enabled).toBe(true);
    expect(failed.nextFireAt.getTime()).toBeGreaterThan(Date.now());
    expect((await schedules.get(project, disabled.id)).lastFiredAt).toBeNull();

    const enabled = await schedules.setEnabled(project, disabled.id, true);
    expect(enabled.nextFireAt.getTime()).toBeGreaterThan(Date.now());
    await schedules.delete(project, disabled.id);
    await expect(schedules.get(project, disabled.id)).rejects.toThrow("does not exist");
  });
});
