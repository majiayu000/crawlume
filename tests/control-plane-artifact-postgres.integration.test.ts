import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactNotFoundError,
  ArtifactRetentionSweeper,
  ArtifactStorageService,
  ArtifactUploadVerificationError,
  type ArtifactObjectStore,
  type StoredObject,
} from "../src/control-plane/artifact-storage.js";
import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";
import { JobResultService, JobResultValidationError } from "../src/control-plane/organization-authorization.js";
import { ControlPlaneJobService } from "../src/control-plane/project-scope.js";
import { PostgresControlPlaneDatabase } from "../src/server.js";
import {
  configuredDatabaseUrl,
  databaseClock,
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

class FakeObjectStore implements ArtifactObjectStore {
  readonly objects = new Map<string, StoredObject>();
  readonly puts: Array<Parameters<ArtifactObjectStore["presignPut"]>> = [];

  async presignPut(...args: Parameters<ArtifactObjectStore["presignPut"]>) {
    this.puts.push(args);
    return { url: `https://objects.example/${args[0]}?signature=put`, headers: { "x-amz-checksum-sha256": args[1].sha256Base64 } };
  }

  async head(key: string) {
    return this.objects.get(key) ?? null;
  }

  async presignGet(key: string) {
    return `https://objects.example/${key}?signature=get`;
  }

  readonly deleted: string[] = [];
  failDeletes = false;

  async delete(key: string) {
    if (this.failDeletes) throw new Error("object storage unavailable");
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

describeWithPostgres("cloud Artifact storage on PostgreSQL", () => {
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

  async function cloudJob(key: string) {
    const storage = new PostgresControlPlaneDatabase(database!);
    const jobs = new ControlPlaneJobService(storage);
    const job = await jobs.createJob(fixtureProjectKey, key, jobInput(`https://example.com/${key}`), {
      correlationId: key,
    });
    const claim = await jobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("The cloud Artifact Job was not claimed.");
    const results = new JobResultService(storage);
    const published = await results.publishResult(fixtureWorker, claim.lease.id, claim.lease.generation, {
      ...publicationInput(1), storage: "cloud_object",
    });
    const store = new FakeObjectStore();
    store.objects.set(published.artifact.objectKey!, {
      byteCount: published.artifact.byteCount,
      sha256Base64: Buffer.from(published.artifact.contentHash, "base64url").toString("base64"),
    });
    return {
      job, jobs, results, published, store,
      artifacts: new ArtifactStorageService(storage, store),
      lease: [fixtureWorker, claim.lease.id, claim.lease.generation] as const,
    };
  }

  it("keeps completion retryable until every cloud Artifact from the lease is confirmed", async () => {
    const { job, jobs, results, published, store, artifacts, lease } = await cloudJob("pending-uploads");
    const second = await results.publishResult(...lease, { ...publicationInput(2), storage: "cloud_object" });
    await results.publishResult(...lease, publicationInput(3));
    for (const resultCompleteness of ["complete", "partial"] as const) {
      await expect(jobs.complete(...lease, { status: "completed", resultCompleteness, errorCode: null }))
        .rejects.toBeInstanceOf(ArtifactUploadVerificationError);
    }
    const pending = await database!.query(`
      SELECT jobs.status, job_leases.status AS lease_status
      FROM jobs INNER JOIN job_leases ON job_leases.job_id = jobs.id
      WHERE jobs.id = $1
    `, [job.id]);
    expect(pending.rows).toEqual([{ status: "running", lease_status: "active" }]);
    const prematureEvents = await database!.query("SELECT id FROM webhook_events WHERE job_id = $1", [job.id]);
    expect(prematureEvents.rows).toEqual([]);

    await artifacts.confirmUpload(...lease, published.artifact.id);
    await expect(jobs.complete(...lease, { status: "completed", resultCompleteness: "complete", errorCode: null }))
      .rejects.toBeInstanceOf(ArtifactUploadVerificationError);
    store.objects.set(second.artifact.objectKey!, {
      byteCount: second.artifact.byteCount,
      sha256Base64: Buffer.from(second.artifact.contentHash, "base64url").toString("base64"),
    });
    await artifacts.confirmUpload(...lease, second.artifact.id);
    await expect(jobs.complete(...lease, { status: "completed", resultCompleteness: "complete", errorCode: null }))
      .resolves.toMatchObject({ status: "completed" });
    await expect(artifacts.downloadUrl(fixtureProjectKey, published.artifact.id, { correlationId: "completed-download" }))
      .resolves.toMatchObject({ url: expect.stringContaining(published.artifact.objectKey!) });
    const terminalEvents = await database!.query("SELECT event_type FROM webhook_events WHERE job_id = $1", [job.id]);
    expect(terminalEvents.rows).toEqual([{ event_type: "job.completed" }]);
  });

  it("allows a failed Job to terminate with an unconfirmed cloud Artifact", async () => {
    const { jobs, lease } = await cloudJob("failed-upload");
    await expect(jobs.complete(...lease, { status: "failed", resultCompleteness: null, errorCode: "UPLOAD_FAILED" }))
      .resolves.toMatchObject({ status: "failed", errorCode: "UPLOAD_FAILED" });
  });

  it.each(["cancel", "expire"] as const)("keeps heartbeat unlocked during HEAD and rechecks a %s transition", async (transition) => {
    const { job, jobs, published, store, artifacts, lease } = await cloudJob(`slow-head-${transition}`);
    let releaseHead!: () => void;
    const pendingHead = new Promise<void>((resolve) => { releaseHead = resolve; });
    let markHeadStarted!: () => void;
    const headStarted = new Promise<void>((resolve) => { markHeadStarted = resolve; });
    vi.spyOn(store, "head").mockImplementation(async (key) => {
      markHeadStarted();
      await pendingHead;
      return store.objects.get(key) ?? null;
    });
    const confirmation = artifacts.confirmUpload(...lease, published.artifact.id)
      .then((uploadedAt) => ({ uploadedAt }), (error: unknown) => ({ error }));
    await headStarted;
    const concurrent = (async () => {
      await jobs.heartbeat(...lease);
      if (transition === "cancel") {
        await jobs.cancel(fixtureProjectKey, job.id);
      } else {
        await database!.query(`
          UPDATE job_leases SET claimed_at = clock_timestamp() - interval '2 minutes',
            heartbeat_at = clock_timestamp() - interval '2 minutes',
            heartbeat_deadline = clock_timestamp() - interval '1 second'
          WHERE id = $1
        `, [lease[1]]);
      }
      return true;
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let finishedBeforeHead: boolean;
    try {
      finishedBeforeHead = await Promise.race([
        concurrent,
        new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 2_000); }),
      ]);
    } finally {
      clearTimeout(timeout);
      releaseHead();
    }
    await concurrent;
    const outcome = await confirmation;
    expect(finishedBeforeHead).toBe(true);
    expect(outcome).toMatchObject({ error: { name: "JobResultLeaseFencedError" } });
    const persisted = await database!.query("SELECT uploaded_at FROM artifact_metadata WHERE id = $1", [published.artifact.id]);
    expect(persisted.rows).toEqual([{ uploaded_at: null }]);
  });

  it("returns the same confirmation when another request finishes during HEAD", async () => {
    const { published, store, artifacts, lease } = await cloudJob("concurrent-confirmation");
    let releaseHead!: () => void;
    const pendingHead = new Promise<void>((resolve) => { releaseHead = resolve; });
    let markHeadStarted!: () => void;
    const headStarted = new Promise<void>((resolve) => { markHeadStarted = resolve; });
    vi.spyOn(store, "head").mockImplementationOnce(async (key) => {
      markHeadStarted();
      await pendingHead;
      return store.objects.get(key) ?? null;
    });
    const first = artifacts.confirmUpload(...lease, published.artifact.id);
    await headStarted;
    let uploadedAt: Date;
    try {
      uploadedAt = await artifacts.confirmUpload(...lease, published.artifact.id);
    } finally {
      releaseHead();
    }
    await expect(first).resolves.toEqual(uploadedAt);
  });

  it("brokers a verified upload under the publishing lease and audits downloads", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => now });
    const job = await jobs.createJob(fixtureProjectKey, "artifact-upload", jobInput("https://example.com/a"), {
      correlationId: "artifact-upload",
    });
    const claim = await jobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("The artifact Job was not claimed.");
    const bytes = Buffer.from("cloud artifact body");
    const contentHash = createHash("sha256").update(bytes).digest();
    const results = new JobResultService(storage);
    const local = await results.publishResult(fixtureWorker, claim.lease.id, claim.lease.generation, publicationInput(1));
    const published = await results.publishResult(fixtureWorker, claim.lease.id, claim.lease.generation, {
      ...publicationInput(2),
      contentHash: contentHash.toString("base64url"),
      byteCount: bytes.byteLength,
      storage: "cloud_object",
    });
    const objectKey = published.artifact.objectKey!;
    expect(objectKey).toBe(
      `organization/${fixture.organizationId}/project/${fixture.projectId}/artifact/${published.artifact.id}/1`,
    );

    const store = new FakeObjectStore();
    const artifacts = new ArtifactStorageService(storage, store);
    const lease = [fixtureWorker, claim.lease.id, claim.lease.generation] as const;
    await expect(artifacts.requestUpload(...lease, local.artifact.id)).rejects.toBeInstanceOf(JobResultValidationError);
    const upload = await artifacts.requestUpload(...lease, published.artifact.id);
    expect(upload).toMatchObject({ method: "PUT", url: expect.stringContaining(objectKey) });
    expect(store.puts[0]?.[1]).toMatchObject({
      byteCount: bytes.byteLength,
      sha256Base64: contentHash.toString("base64"),
      mediaType: "text/markdown",
    });

    await expect(artifacts.confirmUpload(...lease, published.artifact.id))
      .rejects.toBeInstanceOf(ArtifactUploadVerificationError);
    store.objects.set(objectKey, { byteCount: bytes.byteLength, sha256Base64: Buffer.alloc(32).toString("base64") });
    await expect(artifacts.confirmUpload(...lease, published.artifact.id))
      .rejects.toThrow("does not match the published size and SHA-256");
    await expect(artifacts.downloadUrl(fixtureProjectKey, published.artifact.id, { correlationId: "download" }))
      .rejects.toBeInstanceOf(ArtifactNotFoundError);

    store.objects.set(objectKey, { byteCount: bytes.byteLength, sha256Base64: contentHash.toString("base64") });
    const uploadedAt = await artifacts.confirmUpload(...lease, published.artifact.id);
    await expect(artifacts.confirmUpload(...lease, published.artifact.id)).resolves.toEqual(uploadedAt);

    const download = await artifacts.downloadUrl(fixtureProjectKey, published.artifact.id, { correlationId: "download" });
    expect(download.url).toBe(`https://objects.example/${objectKey}?signature=get`);
    const audit = await database!.query<{ action: string; target_id: string; actor_id: string }>(
      "SELECT action, target_id, actor_id FROM audit_events WHERE action = 'artifact.downloaded'",
    );
    expect(audit.rows).toEqual([{ action: "artifact.downloaded", target_id: published.artifact.id, actor_id: fixture.apiKeyId }]);

    await jobs.cancel(fixtureProjectKey, job.id);
    await expect(artifacts.requestUpload(...lease, published.artifact.id)).rejects.toMatchObject({
      name: "JobResultLeaseFencedError",
    });
  });

  it("tombstones expired cloud Artifacts, deletes their objects and retries failed deletions", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const jobs = new ControlPlaneJobService(storage, { now: () => now });
    await jobs.createJob(fixtureProjectKey, "artifact-retention", jobInput("https://example.com/r"), {
      correlationId: "artifact-retention",
    });
    const claim = await jobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("The retention Job was not claimed.");
    const bytes = Buffer.from("expiring artifact");
    const contentHash = createHash("sha256").update(bytes).digest();
    const results = new JobResultService(storage);
    const publish = (localSequence: number) => results.publishResult(fixtureWorker, claim.lease.id, claim.lease.generation, {
      ...publicationInput(localSequence),
      contentHash: contentHash.toString("base64url"),
      byteCount: bytes.byteLength,
      storage: "cloud_object",
    });
    const expired = await publish(1);
    const fresh = await publish(2);
    const local = await results.publishResult(fixtureWorker, claim.lease.id, claim.lease.generation, publicationInput(3));
    await database!.query(
      "UPDATE artifact_metadata SET created_at = created_at - interval '31 days' WHERE id = ANY($1::uuid[])",
      [[expired.artifact.id, local.artifact.id]],
    );
    const store = new FakeObjectStore();
    const artifacts = new ArtifactStorageService(storage, store);
    for (const artifact of [expired.artifact, fresh.artifact]) {
      store.objects.set(artifact.objectKey!, { byteCount: bytes.byteLength, sha256Base64: contentHash.toString("base64") });
      await artifacts.confirmUpload(fixtureWorker, claim.lease.id, claim.lease.generation, artifact.id);
    }

    const sweeper = new ArtifactRetentionSweeper(storage, store, 30);
    store.failDeletes = true;
    await expect(sweeper.sweep()).rejects.toThrow("object storage unavailable");
    await expect(artifacts.downloadUrl(fixtureProjectKey, expired.artifact.id, { correlationId: "d" }))
      .rejects.toBeInstanceOf(ArtifactNotFoundError);

    store.failDeletes = false;
    await expect(sweeper.sweep()).resolves.toBe(1);
    expect(store.deleted).toEqual([expired.artifact.objectKey]);
    await expect(sweeper.sweep()).resolves.toBe(0);
    await expect(artifacts.downloadUrl(fixtureProjectKey, fresh.artifact.id, { correlationId: "d" }))
      .resolves.toMatchObject({ url: expect.stringContaining(fresh.artifact.objectKey!) });
    const states = await database!.query<{ id: string; tombstoned: boolean; deleted: boolean }>(`
      SELECT id, tombstoned_at IS NOT NULL AS tombstoned, object_deleted_at IS NOT NULL AS deleted
      FROM artifact_metadata ORDER BY created_at
    `);
    expect(states.rows).toEqual(expect.arrayContaining([
      { id: expired.artifact.id, tombstoned: true, deleted: true },
      { id: fresh.artifact.id, tombstoned: false, deleted: false },
      { id: local.artifact.id, tombstoned: false, deleted: false },
    ]));
  });
});
