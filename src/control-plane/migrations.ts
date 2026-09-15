import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationFilePattern = /^(?<version>[0-9]{4})_[a-z0-9][a-z0-9_-]*\.sql$/u;
const transactionWrapperPattern = /^\s*BEGIN\s*;\s*([\s\S]*?)\s*COMMIT\s*;\s*$/iu;
const migrationLockName = "diaoyan-control-plane-schema-migrations";
const defaultMigrationDirectory = fileURLToPath(
  new URL("../../migrations/control-plane/", import.meta.url),
);

type Migration = Readonly<{
  version: number;
  name: string;
  checksum: string;
  statement: string;
}>;

type AppliedMigration = Readonly<{
  version: number;
  name: string;
  checksum: string;
}>;

type AdvisoryUnlockRow = Readonly<{
  unlocked: boolean;
}>;

export interface ControlPlaneMigrationClient {
  query<Row>(statement: string, parameters?: readonly unknown[]): Promise<{ rows: Row[] }>;
  release(error?: Error | true): void;
}

export interface ControlPlaneMigrationPool {
  query<Row>(statement: string, parameters?: readonly unknown[]): Promise<{ rows: Row[] }>;
  connect(): Promise<ControlPlaneMigrationClient>;
}

function errorForDiscard(error: unknown): Error | true {
  return error instanceof Error ? error : true;
}

async function readMigrations(directory: string): Promise<readonly Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const migrations: Migration[] = [];

  for (const [index, name] of names.entries()) {
    const match = migrationFilePattern.exec(name);
    if (match?.groups?.version === undefined) {
      throw new Error(`Control-plane migration filename is invalid: ${name}`);
    }
    const version = Number(match.groups.version);
    const expectedVersion = index + 1;
    if (version !== expectedVersion) {
      throw new Error(
        `Control-plane migration sequence expected version ${expectedVersion} but found ${version} in ${name}.`,
      );
    }
    const source = await readFile(join(directory, name), "utf8");
    const wrapper = transactionWrapperPattern.exec(source);
    if (wrapper?.[1] === undefined) {
      throw new Error(`Control-plane migration ${name} must have one outer BEGIN/COMMIT transaction.`);
    }
    migrations.push(Object.freeze({
      version,
      name,
      checksum: createHash("sha256").update(source).digest("hex"),
      statement: wrapper[1].trim(),
    }));
  }

  if (migrations.length === 0) {
    throw new Error("No control-plane migration files were found.");
  }
  return migrations;
}

function assertAppliedPrefix(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): void {
  for (const [index, record] of applied.entries()) {
    const expected = migrations[index];
    if (expected === undefined) {
      throw new Error(`Control-plane schema has unexpected migration version ${record.version}.`);
    }
    if (
      record.version !== expected.version ||
      record.name !== expected.name ||
      record.checksum !== expected.checksum
    ) {
      throw new Error(
        `Applied control-plane migration version ${record.version} does not match ${expected.name}.`,
      );
    }
  }
}

function assertCurrent(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): void {
  assertAppliedPrefix(migrations, applied);
  const expectedVersion = migrations.at(-1)?.version;
  const actualVersion = applied.at(-1)?.version ?? 0;
  if (expectedVersion === undefined || actualVersion !== expectedVersion) {
    throw new Error(
      `Control-plane schema is not current: expected version ${expectedVersion ?? 0}, found ${actualVersion}.`,
    );
  }
}

async function listAppliedMigrations(
  database: Pick<ControlPlaneMigrationPool, "query">,
): Promise<readonly AppliedMigration[]> {
  const result = await database.query<AppliedMigration>(`
    SELECT version, name, checksum
    FROM control_plane_schema_migrations
    ORDER BY version
  `, []);
  return result.rows;
}

async function inTransaction(
  client: ControlPlaneMigrationClient,
  operation: () => Promise<void>,
  discard: (error: unknown) => void,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await operation();
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discard(rollbackError);
      throw new AggregateError(
        [error, rollbackError],
        "The control-plane migration and rollback both failed.",
      );
    }
    throw error;
  }
}

export async function assertControlPlaneSchemaCurrent(
  database: Pick<ControlPlaneMigrationPool, "query">,
  directory = defaultMigrationDirectory,
): Promise<void> {
  const migrations = await readMigrations(directory);
  assertCurrent(migrations, await listAppliedMigrations(database));
}

export async function runControlPlaneMigrations(
  pool: ControlPlaneMigrationPool,
  directory = defaultMigrationDirectory,
): Promise<void> {
  const migrations = await readMigrations(directory);
  const client = await pool.connect();
  let locked = false;
  let failed = false;
  let failure: unknown;
  let discardError: Error | true | undefined;

  const discard = (error: unknown): void => {
    discardError ??= errorForDiscard(error);
  };

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [migrationLockName]);
    locked = true;
    await inTransaction(client, async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS control_plane_schema_migrations (
          version INTEGER PRIMARY KEY CHECK (version > 0),
          name TEXT NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
          checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }, discard);

    const applied = await listAppliedMigrations(client);
    assertAppliedPrefix(migrations, applied);
    for (const migration of migrations.slice(applied.length)) {
      await inTransaction(client, async () => {
        await client.query(migration.statement);
        await client.query(`
          INSERT INTO control_plane_schema_migrations(version, name, checksum)
          VALUES ($1, $2, $3)
        `, [migration.version, migration.name, migration.checksum]);
      }, discard);
    }
    assertCurrent(migrations, await listAppliedMigrations(client));
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (locked && discardError === undefined) {
      try {
        const result = await client.query<AdvisoryUnlockRow>(
          "SELECT pg_advisory_unlock(hashtext($1)) AS unlocked",
          [migrationLockName],
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error("The control-plane migration advisory lock was not held.");
        }
      } catch (unlockError) {
        discard(unlockError);
        failure = !failed
          ? unlockError
          : new AggregateError(
            [failure, unlockError],
            "Control-plane migration and advisory lock release both failed.",
          );
        failed = true;
      }
    }
    try {
      client.release(discardError);
    } catch (releaseError) {
      failure = !failed
        ? releaseError
        : new AggregateError(
          [failure, releaseError],
          "Control-plane migration and client release both failed.",
        );
      failed = true;
    }
  }

  if (failed) throw failure;
}
