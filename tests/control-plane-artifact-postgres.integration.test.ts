import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactNotFoundError,
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
});
