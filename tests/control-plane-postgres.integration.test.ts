import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";

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

describeWithPostgres("control-plane migrations on PostgreSQL", () => {
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
    database = new Pool({ connectionString: databaseUrl(databaseName), max: 2 });
    await database.query("SELECT 1");
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
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "PostgreSQL integration test cleanup failed.");
    }
  });

  afterAll(async () => {
    await administration.end();
  });

  it("executes all seven checked-in migrations on an empty database", async () => {
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
    ]);
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
});
