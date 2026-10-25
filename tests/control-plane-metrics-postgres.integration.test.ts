import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ControlPlaneMetrics } from "../src/control-plane/control-metrics.js";
import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";
import { ControlPlaneJobService } from "../src/control-plane/project-scope.js";
import { PostgresControlPlaneDatabase } from "../src/server.js";
import {
  configuredDatabaseUrl,
  databaseClock,
  databaseUrl,
  fixtureProjectKey,
  fixtureWorker,
  jobInput,
  quotedTestDatabase,
  requiredDatabaseUrl,
  seedRuntimeFixture,
} from "./control-plane-job-fixture.js";
import { trackPoolErrors } from "./helpers.js";

const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;

function sample(text: string, series: string): number {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${series} `));
  if (line === undefined) throw new Error(`Missing metric series ${series}`);
  return Number(line.slice(series.length + 1));
}

describeWithPostgres("control-plane metrics on PostgreSQL", () => {
  let administration: Pool;
  let database: Pool | undefined;
  let databaseName: string | undefined;
  const unexpectedPoolErrors: unknown[] = [];

  beforeAll(async () => {
    administration = new Pool({ connectionString: requiredDatabaseUrl(), max: 1 });
    await administration.query("SELECT 1");
  });

  beforeEach(async () => {
    databaseName = `diaoyan_test_${randomUUID().replaceAll("-", "")}`;
    await administration.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
    database = trackPoolErrors(new Pool({ connectionString: databaseUrl(databaseName), max: 2 }), unexpectedPoolErrors);
    await runControlPlaneMigrations(database);
    await seedRuntimeFixture(database);
  });

  afterEach(async () => {
    await database?.end();
    database = undefined;
    if (databaseName !== undefined) {
      await administration.query(`DROP DATABASE ${quotedTestDatabase(databaseName)} WITH (FORCE)`);
      databaseName = undefined;
    }
    expect(unexpectedPoolErrors.splice(0)).toEqual([]);
  });

  afterAll(async () => {
    await administration.end();
  });

  it("reflects queue, lease, worker and terminal state from the real schema", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const metrics = new ControlPlaneMetrics(storage);
    const empty = await metrics.prometheusText();
    expect(sample(empty, 'crawlume_control_jobs{status="queued"}')).toBe(0);
    expect(sample(empty, "crawlume_control_oldest_queued_job_age_seconds")).toBe(0);

    const now = await databaseClock(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => now });
    const context = { correlationId: "metrics" };
    await jobs.createJob(fixtureProjectKey, "metrics-claimed", jobInput("https://example.com/a"), context);
    await jobs.createJob(fixtureProjectKey, "metrics-queued", jobInput("https://example.com/b"), context);
    const cancelled = await jobs.createJob(fixtureProjectKey, "metrics-cancelled", jobInput("https://example.com/c"), context);
    await jobs.cancel(fixtureProjectKey, cancelled.id);
    const claim = await jobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("No Job was claimed.");

    const busy = await metrics.prometheusText();
    expect(sample(busy, 'crawlume_control_jobs{status="queued"}')).toBe(1);
    expect(sample(busy, 'crawlume_control_jobs{status="running"}')).toBe(1);
    expect(sample(busy, 'crawlume_control_jobs_terminal_total{status="cancelled"}')).toBe(1);
    expect(sample(busy, "crawlume_control_oldest_queued_job_age_seconds")).toBeGreaterThanOrEqual(0);
    expect(sample(busy, "crawlume_control_active_leases")).toBe(1);
    expect(sample(busy, "crawlume_control_overdue_leases")).toBe(0);
    expect(sample(busy, 'crawlume_control_workers{status="active"}')).toBe(3);
    expect(sample(busy, "crawlume_control_workers_with_session")).toBe(3);

    await database!.query(`
      UPDATE job_leases SET claimed_at = claimed_at - interval '1 hour',
        heartbeat_at = heartbeat_at - interval '1 hour',
        heartbeat_deadline = heartbeat_deadline - interval '1 hour'
      WHERE id = $1
    `, [claim.lease.id]);
    await database!.query("UPDATE jobs SET created_at = created_at - interval '10 minutes' WHERE status = 'queued'");
    const stalled = await metrics.prometheusText();
    expect(sample(stalled, "crawlume_control_overdue_leases")).toBe(1);
    expect(sample(stalled, "crawlume_control_oldest_queued_job_age_seconds")).toBeGreaterThanOrEqual(600);
    expect(sample(stalled, "crawlume_control_metrics_scrape_duration_seconds")).toBeGreaterThan(0);
  });
});
