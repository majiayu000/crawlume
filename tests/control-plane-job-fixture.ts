import { Pool } from "pg";

import type {
  AuthenticatedProjectApiKey,
  AuthenticatedWorker,
} from "../src/control-plane/api-key-service.js";
import type {
  JobEventInput,
  PublishJobResultInput,
} from "../src/control-plane/organization-authorization.js";
import type { CreateControlPlaneJobInput } from "../src/control-plane/project-scope.js";

// Shared PostgreSQL fixture for control-plane Job integration tests (run through `pnpm test:postgres`).

export const configuredDatabaseUrl = process.env.DIAOYAN_TEST_POSTGRES_URL;

export const fixture = Object.freeze({
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
export const fixtureNow = new Date("2030-01-01T00:00:00.000Z");
export const fixtureCapabilityHash = Buffer.alloc(32, 13);
export const fixtureWorker: AuthenticatedWorker = Object.freeze({
  workerId: fixture.workerId,
  projectId: fixture.projectId,
  sessionId: fixture.sessionId,
  capabilityHash: fixtureCapabilityHash.toString("base64url"),
});
export const privateCapabilityHash = Buffer.alloc(32, 15);
export const privateWorker: AuthenticatedWorker = Object.freeze({
  workerId: fixture.privateWorkerId,
  projectId: fixture.projectId,
  sessionId: fixture.privateSessionId,
  capabilityHash: privateCapabilityHash.toString("base64url"),
});
export const pinnedCapabilityHash = Buffer.alloc(32, 16);
export const pinnedWorker: AuthenticatedWorker = Object.freeze({
  workerId: fixture.pinnedWorkerId,
  projectId: fixture.projectId,
  sessionId: fixture.pinnedSessionId,
  capabilityHash: pinnedCapabilityHash.toString("base64url"),
});
export const fixtureProjectKey: AuthenticatedProjectApiKey = Object.freeze({
  apiKeyId: fixture.apiKeyId,
  projectId: fixture.projectId,
  organizationId: fixture.organizationId,
  createdByUserId: fixture.userId,
  scopes: Object.freeze(["tasks:write"] as const),
});

export function requiredDatabaseUrl(): string {
  if (configuredDatabaseUrl === undefined) {
    throw new Error(
      "DIAOYAN_TEST_POSTGRES_URL is required. Run the dedicated `pnpm test:postgres` Gate.",
    );
  }
  return configuredDatabaseUrl;
}

export function quotedTestDatabase(name: string): string {
  if (!/^diaoyan_test_[0-9a-f]{32}$/u.test(name)) {
    throw new Error(`Refusing to use an unexpected PostgreSQL test database name: ${name}`);
  }
  return `"${name}"`;
}

export function databaseUrl(name: string): string {
  const url = new URL(requiredDatabaseUrl());
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DIAOYAN_TEST_POSTGRES_URL must use postgres or postgresql.");
  }
  url.pathname = `/${name}`;
  url.searchParams.set("application_name", "diaoyan-job-03");
  return url.toString();
}

export function jobInput(url: string): CreateControlPlaneJobInput {
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

export function privateJobInput(
  url: string,
  pinnedWorkerId: string | null,
): CreateControlPlaneJobInput {
  return Object.freeze({
    ...jobInput(url),
    dataClass: "authorized" as const,
    placement: Object.freeze({ class: "private" as const, pinnedWorkerId }),
  });
}

export function eventInput(localSequence: number): JobEventInput {
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

export function publicationInput(localSequence: number): PublishJobResultInput {
  return Object.freeze({
    localSequence,
    contentHash: Buffer.alloc(32, 22).toString("base64url"),
    byteCount: 2_048,
    mediaType: "text/markdown",
    completeness: "complete" as const,
    storage: "worker_local" as const,
  });
}

export async function seedRuntimeFixture(database: Pool): Promise<void> {
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

export async function databaseClock(database: Pool): Promise<Date> {
  const result = await database.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new Error("PostgreSQL did not return its current clock.");
  return now;
}
