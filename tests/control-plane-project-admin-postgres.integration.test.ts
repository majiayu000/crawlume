import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";
import {
  createOrganizationProject,
  ProjectCreationIdempotencyConflictError,
} from "../src/control-plane/project-admin-management.js";
import { PostgresControlPlaneDatabase } from "../src/server.js";

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

describeWithPostgres("Project Admin PostgreSQL integration", () => {
  const databaseName = `diaoyan_test_${randomUUID().replaceAll("-", "")}`;
  const userId = "10000000-0000-4000-8000-000000000001";
  const organizationId = "10000000-0000-4000-8000-000000000002";
  let administrator: Pool;
  let pool: Pool;
  let database: PostgresControlPlaneDatabase;

  beforeAll(async () => {
    administrator = new Pool({ connectionString: requiredDatabaseUrl(), max: 1 });
    await administrator.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
    pool = new Pool({ connectionString: databaseUrl(databaseName), max: 4 });
    await runControlPlaneMigrations(pool);
    database = new PostgresControlPlaneDatabase(pool);
    await pool.query(`
      INSERT INTO users(id, oidc_issuer, oidc_subject)
      VALUES ($1, $2, $3)
    `, [userId, "https://issuer.example", "http-02-user"]);
    await pool.query(`
      INSERT INTO organizations(id, slug, name, kind)
      VALUES ($1, $2, $3, 'business')
    `, [organizationId, "http-02-org", "HTTP-02 Organization"]);
    await pool.query(`
      INSERT INTO organization_memberships(organization_id, user_id, role)
      VALUES ($1, $2, 'owner')
    `, [organizationId, userId]);
  });

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
    if (administrator !== undefined) {
      await administrator.query(`DROP DATABASE IF EXISTS ${quotedTestDatabase(databaseName)}`);
      await administrator.end();
    }
  });

  it("serializes concurrent Project creation and rejects key reuse with another payload", async () => {
    const input = { slug: "research", name: "Research" } as const;
    const context = { correlationId: "http-02-concurrent" } as const;

    const [first, second] = await Promise.all([
      createOrganizationProject(
        database,
        { userId },
        organizationId,
        " concurrent-create ",
        input,
        context,
      ),
      createOrganizationProject(
        database,
        { userId },
        organizationId,
        "concurrent-create",
        input,
        context,
      ),
    ]);

    expect(second).toEqual(first);
    await expect(createOrganizationProject(
      database,
      { userId },
      organizationId,
      "concurrent-create",
      { slug: "different", name: "Different" },
      context,
    )).rejects.toEqual(new ProjectCreationIdempotencyConflictError());

    const projects = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM projects
      WHERE organization_id = $1 AND slug = 'research'
    `, [organizationId]);
    const records = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM project_creation_idempotency
      WHERE organization_id = $1 AND idempotency_key = 'concurrent-create'
    `, [organizationId]);
    const audits = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM audit_events
      WHERE project_id = $1 AND action = 'project.created'
    `, [first.id]);
    expect(projects.rows[0]?.count).toBe("1");
    expect(records.rows[0]?.count).toBe("1");
    expect(audits.rows[0]?.count).toBe("1");
  });
});
