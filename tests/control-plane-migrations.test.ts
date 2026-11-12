import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertControlPlaneSchemaCurrent,
  runControlPlaneMigrations,
  type ControlPlaneMigrationClient,
  type ControlPlaneMigrationPool,
} from "../src/control-plane/migrations.js";

type AppliedMigration = Readonly<{
  version: number;
  name: string;
  checksum: string;
}>;

class MigrationClient implements ControlPlaneMigrationClient {
  readonly statements: string[] = [];
  readonly parameters: Array<readonly unknown[]> = [];
  readonly applied = new Map<number, AppliedMigration>();
  releasedWith: Error | true | undefined | null = null;
  failOn = "";
  rollbackError: Error | null = null;
  private pending: AppliedMigration[] = [];

  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<{ rows: Row[] }> {
    const sql = statement.trim();
    this.statements.push(sql);
    this.parameters.push(parameters);

    if (sql === "ROLLBACK" && this.rollbackError !== null) throw this.rollbackError;
    if (this.failOn !== "" && sql.includes(this.failOn)) {
      throw new Error(`migration failed at ${this.failOn}`);
    }
    if (sql === "BEGIN") {
      this.pending = [];
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      for (const migration of this.pending) this.applied.set(migration.version, migration);
      this.pending = [];
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      this.pending = [];
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO control_plane_schema_migrations")) {
      this.pending.push({
        version: Number(parameters[0]),
        name: String(parameters[1]),
        checksum: String(parameters[2]),
      });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT version, name, checksum")) {
      const rows = [...this.applied.values()].sort((left, right) => left.version - right.version);
      return { rows: rows as Row[] };
    }
    if (sql.startsWith("SELECT pg_advisory_unlock")) {
      return { rows: [{ unlocked: true }] as Row[] };
    }
    return { rows: [] };
  }

  release(error?: Error | true): void {
    this.releasedWith = error ?? undefined;
  }
}

class MigrationPool implements ControlPlaneMigrationPool {
  constructor(readonly client = new MigrationClient()) {}

  async connect(): Promise<ControlPlaneMigrationClient> {
    return this.client;
  }

  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<{ rows: Row[] }> {
    return this.client.query<Row>(statement, parameters);
  }
}

const temporaryDirectories: string[] = [];

async function migrationDirectory(names = ["0001_first.sql", "0002_second.sql", "0003_third.sql"]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diaoyan-control-migrations-"));
  temporaryDirectories.push(directory);
  await Promise.all(names.map(async (name) => {
    const marker = name.slice(5, -4).toUpperCase();
    await writeFile(join(directory, name), `BEGIN;\n\nSELECT '${marker}';\n\nCOMMIT;\n`);
  }));
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("control-plane migration runner", () => {
  it("loads all checked-in migrations from the production directory", async () => {
    const pool = new MigrationPool();

    await runControlPlaneMigrations(pool);

    expect([...pool.client.applied.values()].map(({ version, name }) => ({ version, name }))).toEqual([
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
      { version: 13, name: "0013_project_storage_and_schedules.sql" },
    ]);
  });

  it("applies an empty database in filename order and does not reapply migrations", async () => {
    const directory = await migrationDirectory();
    const pool = new MigrationPool();

    await runControlPlaneMigrations(pool, directory);

    const migrationStatements = pool.client.statements.filter((statement) => /^SELECT '(?:FIRST|SECOND|THIRD)'/u.test(statement));
    expect(migrationStatements).toEqual(["SELECT 'FIRST';", "SELECT 'SECOND';", "SELECT 'THIRD';"]);
    expect([...pool.client.applied.values()].map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: "0001_first.sql" },
      { version: 2, name: "0002_second.sql" },
      { version: 3, name: "0003_third.sql" },
    ]);

    const statementCount = pool.client.statements.length;
    await runControlPlaneMigrations(pool, directory);

    expect(pool.client.statements.slice(statementCount).filter((statement) => /^SELECT '(?:FIRST|SECOND|THIRD)'/u.test(statement))).toEqual([]);
    expect(pool.client.releasedWith).toBeUndefined();
  });

  it("rolls back a failed migration and stops before later files", async () => {
    const directory = await migrationDirectory();
    const pool = new MigrationPool();
    pool.client.failOn = "SELECT 'SECOND'";

    await expect(runControlPlaneMigrations(pool, directory)).rejects.toThrow("migration failed at SELECT 'SECOND'");

    expect([...pool.client.applied.keys()]).toEqual([1]);
    expect(pool.client.statements).toContain("ROLLBACK");
    expect(pool.client.statements.some((statement) => statement.includes("SELECT 'THIRD'"))).toBe(false);
    expect(pool.client.releasedWith).toBeUndefined();
  });

  it("preserves rollback failures and discards the broken connection", async () => {
    const directory = await migrationDirectory();
    const pool = new MigrationPool();
    const rollbackError = new Error("rollback failed");
    pool.client.failOn = "SELECT 'SECOND'";
    pool.client.rollbackError = rollbackError;

    const failure = await runControlPlaneMigrations(pool, directory).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "migration failed at SELECT 'SECOND'",
      "rollback failed",
    ]);
    expect(pool.client.statements.some((statement) => statement.includes("SELECT 'THIRD'"))).toBe(false);
    expect(pool.client.releasedWith).toBe(rollbackError);
  });

  it("fails the schema gate when a migration is missing or has changed", async () => {
    const directory = await migrationDirectory();
    const pool = new MigrationPool();
    await runControlPlaneMigrations(pool, directory);

    pool.client.applied.delete(3);
    await expect(assertControlPlaneSchemaCurrent(pool, directory)).rejects.toThrow("expected version 3");

    const first = pool.client.applied.get(1);
    if (first === undefined) throw new Error("Expected migration 1 to be applied.");
    pool.client.applied.set(1, { ...first, checksum: "changed" });
    await expect(assertControlPlaneSchemaCurrent(pool, directory)).rejects.toThrow("does not match");
  });
});
