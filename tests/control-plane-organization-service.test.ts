import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  JobResultIdempotencyConflictError,
  JobResultLeaseFencedError,
  JobResultService,
  JobResultValidationError,
  JobResultWorkerAccessDeniedError,
  PrivateArtifactUploadDeniedError,
  type JobEventInput,
  type PublishJobResultInput,
} from "../src/control-plane/organization-authorization.js";
import {
  addOrganizationMember,
  changeOrganizationMemberRole,
  createProject,
  LastOrganizationOwnerError,
  OrganizationAccessDeniedError,
  OrganizationMembershipConflictError,
  ProjectSlugConflictError,
  removeOrganizationMember,
  WorkerHttpApi,
} from "../src/control-plane/organization-service.js";
import {
  LeaseFencedError,
  resolveProjectScope,
  type ControlPlaneJob,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
  type JobLease,
  type OrganizationRole,
  type ProjectScope,
} from "../src/control-plane/project-scope.js";
import type { AuthenticatedWorker } from "../src/control-plane/api-key-service.js";

type Response = { rows: unknown[] };

class ScriptedDatabase implements ControlPlaneDatabase {
  readonly calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];
  transactions = 0;

  constructor(private readonly responses: Response[]) {}

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    return operation(this);
  }

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.calls.push({ statement, parameters });
    const response = statement.includes("INSERT INTO audit_events")
      ? { rows: [{ id: "audit-event" }] } : this.responses.shift();
    if (response === undefined) {
      throw new Error("Unexpected control-plane query.");
    }
    return response as { rows: Row[] };
  }
}

async function scope(role: OrganizationRole = "owner"): Promise<ProjectScope> {
  return resolveProjectScope(
    new ScriptedDatabase([{ rows: [{
      project_id: "project-a",
      organization_id: "organization-a",
      role,
    }] }]),
    { userId: "actor-a" },
    "project-a",
  );
}

function lockAndActor(role: OrganizationRole): Response[] {
  return [
    { rows: [{ id: "organization-a" }] },
    { rows: [{ role }] },
  ];
}

const auditContext = { correlationId: "correlation-a" };

describe("organization member management", () => {
  it("allows a current owner to add an existing user", async () => {
    const database = new ScriptedDatabase([
      ...lockAndActor("owner"),
      { rows: [{ id: "user-b" }] },
      { rows: [{ organization_id: "organization-a", user_id: "user-b", role: "admin" }] },
    ]);

    await expect(addOrganizationMember(
      database,
      await scope("owner"),
      { userId: "user-b", role: "admin" }, auditContext,
    )).resolves.toEqual({
      organizationId: "organization-a",
      userId: "user-b",
      role: "admin",
    });
    expect(database.transactions).toBe(1);
    expect(database.calls[0]?.statement).toContain("FOR UPDATE");
    expect(database.calls[3]?.parameters).toEqual(["organization-a", "user-b", "admin"]);
    expect(database.calls.at(-1)?.statement).toContain("INSERT INTO audit_events");
  });

  it("revalidates the actor role and rejects a stale owner scope", async () => {
    const database = new ScriptedDatabase(lockAndActor("admin"));

    await expect(addOrganizationMember(
      database,
      await scope("owner"),
      { userId: "user-b", role: "member" }, auditContext,
    )).rejects.toEqual(new OrganizationAccessDeniedError());
    expect(database.calls).toHaveLength(2);
  });

  it("reports an existing membership without replacing its role", async () => {
    const database = new ScriptedDatabase([
      ...lockAndActor("owner"),
      { rows: [{ id: "user-b" }] },
      { rows: [] },
    ]);

    await expect(addOrganizationMember(
      database,
      await scope(),
      { userId: "user-b", role: "admin" }, auditContext,
    )).rejects.toEqual(new OrganizationMembershipConflictError());
  });

  it("rejects demoting the last owner before issuing an update", async () => {
    const database = new ScriptedDatabase([
      ...lockAndActor("owner"),
      { rows: [{ role: "owner" }] },
      { rows: [{ owner_count: "1" }] },
    ]);

    await expect(changeOrganizationMemberRole(
      database,
      await scope(),
      "actor-a",
      "admin", auditContext,
    )).rejects.toEqual(new LastOrganizationOwnerError());
    expect(database.calls).toHaveLength(4);
  });

  it("allows demoting an owner when another owner remains", async () => {
    const database = new ScriptedDatabase([
      ...lockAndActor("owner"),
      { rows: [{ role: "owner" }] },
      { rows: [{ owner_count: "2" }] },
      { rows: [{ organization_id: "organization-a", user_id: "actor-a", role: "admin" }] },
    ]);

    await expect(changeOrganizationMemberRole(
      database,
      await scope(),
      "actor-a",
      "admin", auditContext,
    )).resolves.toMatchObject({ userId: "actor-a", role: "admin" });
  });

  it("rejects removing the last owner before issuing a delete", async () => {
    const database = new ScriptedDatabase([
      ...lockAndActor("owner"),
      { rows: [{ role: "owner" }] },
      { rows: [{ owner_count: 1 }] },
    ]);

    await expect(removeOrganizationMember(
      database,
      await scope(),
      "actor-a", auditContext,
    )).rejects.toEqual(new LastOrganizationOwnerError());
    expect(database.calls.at(-1)?.statement).toContain("count(*)");
  });

  it("removes a non-owner within the scoped organization", async () => {
    const database = new ScriptedDatabase([
      ...lockAndActor("owner"),
      { rows: [{ role: "member" }] },
      { rows: [{ organization_id: "organization-a", user_id: "user-b", role: "member" }] },
    ]);

    await expect(removeOrganizationMember(
      database,
      await scope(),
      "user-b", auditContext,
    )).resolves.toEqual({
      organizationId: "organization-a",
      userId: "user-b",
      role: "member",
    });
    expect(database.calls.at(-2)?.parameters).toEqual(["organization-a", "user-b"]);
  });
});

describe("project management", () => {
  it.each(["owner", "admin"] as const)("allows a current %s to create a project", async (role) => {
    const database = new ScriptedDatabase([
      ...lockAndActor(role),
      { rows: [{
        id: "project-new",
        organization_id: "organization-a",
        slug: "new-project",
        name: "New Project",
      }] },
    ]);

    await expect(createProject(database, await scope(role), {
      id: "project-new",
      slug: "new-project",
      name: "New Project",
    }, auditContext)).resolves.toEqual({
      id: "project-new",
      organizationId: "organization-a",
      slug: "new-project",
      name: "New Project",
    });
    expect(database.calls[2]?.parameters).toEqual([
      "project-new",
      "organization-a",
      "new-project",
      "New Project",
    ]);
  });

  it("rejects a current member before inserting a project", async () => {
    const database = new ScriptedDatabase(lockAndActor("member"));

    await expect(createProject(database, await scope("admin"), {
      id: "project-new",
      slug: "new-project",
      name: "New Project",
    }, auditContext)).rejects.toEqual(new OrganizationAccessDeniedError());
    expect(database.calls).toHaveLength(2);
  });

  it("reports a duplicate slug within the scoped organization", async () => {
    const database = new ScriptedDatabase([
      ...lockAndActor("admin"),
      { rows: [] },
    ]);

    await expect(createProject(database, await scope("admin"), {
      id: "project-new",
      slug: "existing",
      name: "Existing",
    }, auditContext)).rejects.toEqual(new ProjectSlugConflictError());
  });
});

const resultHash = Buffer.alloc(32, 7).toString("base64url");
const occurredAt = new Date("2026-09-01T10:00:00.000Z");
const recordedAt = new Date("2026-09-01T10:00:01.000Z");
const workerIdentity: AuthenticatedWorker = Object.freeze({
  workerId: "worker-a",
  projectId: "project-a",
  capabilityHash: Buffer.alloc(32, 3).toString("base64url"),
  sessionId: "session-a",
});

const eventInput: JobEventInput = {
  localSequence: 3,
  eventType: "page-fetched",
  pageStatus: 200,
  errorCode: null,
  provider: "http",
  byteCount: 4096,
  durationMs: 125,
  contentHash: resultHash,
  usage: { requests: 1, bytes: 4096 },
  occurredAt,
};

const publicationInput: PublishJobResultInput = {
  localSequence: 4,
  contentHash: resultHash,
  byteCount: 4096,
  mediaType: "text/html",
  completeness: "complete",
  storage: "worker_local",
};

function submissionLease(
  dataClass: "public" | "authorized" | "intranet" = "public",
  uploadPrivateArtifact = false,
): Response {
  return { rows: [{
    job_id: "job-a",
    organization_id: "organization-a",
    data_class: dataClass,
    upload_private_artifact: uploadPrivateArtifact,
  }] };
}

function lockedSubmissionLease(): Response {
  return { rows: [{ job_id: "job-a" }] };
}

function eventRow(payload: Buffer = Buffer.alloc(32, 9)): Record<string, unknown> {
  return {
    id: "event-a",
    project_id: "project-a",
    job_id: "job-a",
    lease_id: "lease-a",
    worker_id: "worker-a",
    lease_generation: "2",
    local_sequence: "3",
    sequence: "8",
    payload_hash: payload,
    event_type: "page-fetched",
    page_status: 200,
    error_code: null,
    provider: "http",
    byte_count: "4096",
    duration_ms: "125",
    content_hash: Buffer.alloc(32, 7),
    usage: { bytes: 4096, requests: 1 },
    occurred_at: occurredAt,
    recorded_at: recordedAt,
  };
}

function artifactRow(storage: "worker_local" | "cloud_object", objectKey: string | null) {
  return {
    id: "artifact-a",
    project_id: "project-a",
    job_id: "job-a",
    version: 1,
    content_hash: Buffer.alloc(32, 7),
    byte_count: "4096",
    media_type: "text/html",
    storage_kind: storage,
    object_key: objectKey,
    created_at: recordedAt,
  };
}

function publicationRow(publicationHash: Buffer = Buffer.alloc(32, 9)) {
  return {
    id: "publication-a",
    project_id: "project-a",
    job_id: "job-a",
    lease_id: "lease-a",
    worker_id: "worker-a",
    lease_generation: "2",
    local_sequence: "4",
    sequence: "6",
    publication_hash: publicationHash,
    artifact_id: "artifact-a",
    result_completeness: "complete" as const,
    recorded_at: recordedAt,
  };
}

function eventPayloadHash(): Buffer {
  return createHash("sha256").update(JSON.stringify({
    localSequence: 3,
    eventType: "page-fetched",
    pageStatus: 200,
    errorCode: null,
    provider: "http",
    byteCount: 4096,
    durationMs: 125,
    contentHash: Buffer.alloc(32, 7),
    usage: { bytes: 4096, requests: 1 },
    occurredAt: occurredAt.toISOString(),
  })).digest();
}

function publicationPayloadHash(storage: "worker_local" | "cloud_object" = "worker_local"): Buffer {
  return createHash("sha256").update(JSON.stringify({
    localSequence: 4,
    contentHash: Buffer.alloc(32, 7),
    byteCount: 4096,
    mediaType: "text/html",
    completeness: "complete",
    storage,
  })).digest();
}

describe("Job result submission", () => {
  it("appends only structured event metadata under the authenticated lease", async () => {
    const database = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      lockedSubmissionLease(),
      submissionLease(),
      { rows: [] },
      { rows: [{ sequence: "8" }] },
      { rows: [eventRow()] },
    ]);

    await expect(new JobResultService(database).appendEvent(
      workerIdentity, "lease-a", 2, eventInput,
    )).resolves.toMatchObject({
      id: "event-a",
      projectId: "project-a",
      jobId: "job-a",
      leaseGeneration: 2,
      localSequence: 3,
      sequence: 8,
      contentHash: resultHash,
    });
    expect(database.transactions).toBe(1);
    expect(database.calls[1]?.statement).toContain("FOR UPDATE");
    expect(database.calls[1]?.parameters).toEqual(["lease-a", "worker-a", "project-a", 2]);
    expect(database.calls[2]?.statement).toContain("FOR UPDATE OF jobs");
    expect(database.calls[2]?.parameters).toEqual(["job-a", "project-a", "lease-a"]);
    expect(database.calls[3]?.statement).toContain("project_id = $3");
    expect(database.calls[3]?.parameters).toEqual(["lease-a", 3, "project-a"]);
    expect(database.calls[4]?.statement).toContain("project_id = $2");
    expect(database.calls[4]?.parameters).toEqual(["job-a", "project-a"]);
    expect(database.calls[5]?.statement).not.toMatch(/body|cookie|authorization|source_url/i);
    expect(database.calls[5]?.parameters[16]).toBe(JSON.stringify({ bytes: 4096, requests: 1 }));
  });

  it("replays an identical event and rejects reuse with different metadata", async () => {
    const replayDatabase = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      lockedSubmissionLease(),
      submissionLease(),
      { rows: [eventRow(eventPayloadHash())] },
    ]);
    await expect(new JobResultService(replayDatabase).appendEvent(
      workerIdentity, "lease-a", 2, eventInput,
    )).resolves.toMatchObject({ id: "event-a", sequence: 8 });
    expect(replayDatabase.calls).toHaveLength(4);
    expect(replayDatabase.calls[3]?.parameters).toEqual(["lease-a", 3, "project-a"]);

    const conflictDatabase = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      lockedSubmissionLease(),
      submissionLease(),
      { rows: [eventRow(Buffer.alloc(32, 1))] },
    ]);
    await expect(new JobResultService(conflictDatabase).appendEvent(
      workerIdentity, "lease-a", 2, eventInput,
    )).rejects.toEqual(new JobResultIdempotencyConflictError());
  });

  it("rejects inactive Worker sessions and fenced lease generations explicitly", async () => {
    const inactiveDatabase = new ScriptedDatabase([{ rows: [] }]);
    await expect(new JobResultService(inactiveDatabase).appendEvent(
      workerIdentity, "lease-a", 2, eventInput,
    )).rejects.toEqual(new JobResultWorkerAccessDeniedError());
    expect(inactiveDatabase.calls).toHaveLength(1);

    const fencedDatabase = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      { rows: [] },
    ]);
    await expect(new JobResultService(fencedDatabase).appendEvent(
      workerIdentity, "lease-a", 1, eventInput,
    )).rejects.toEqual(new JobResultLeaseFencedError());
    expect(fencedDatabase.calls[1]?.parameters).toEqual(["lease-a", "worker-a", "project-a", 1]);
  });

  it("rejects malformed hashes and usage before opening a transaction", async () => {
    const database = new ScriptedDatabase([]);
    await expect(new JobResultService(database).appendEvent(
      workerIdentity,
      "lease-a",
      2,
      { ...eventInput, contentHash: "not-a-hash" },
    )).rejects.toBeInstanceOf(JobResultValidationError);
    await expect(new JobResultService(database).appendEvent(
      workerIdentity,
      "lease-a",
      2,
      { ...eventInput, usage: { requests: Number.NaN } },
    )).rejects.toBeInstanceOf(JobResultValidationError);
    expect(database.transactions).toBe(0);
  });

  it("keeps private Artifact bytes local by default", async () => {
    const database = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      lockedSubmissionLease(),
      submissionLease("authorized", false),
      { rows: [] },
      { rows: [{ sequence: "6" }] },
      { rows: [artifactRow("worker_local", null)] },
      { rows: [publicationRow()] },
    ]);
    await expect(new JobResultService(database).publishResult(
      workerIdentity, "lease-a", 2, publicationInput,
    )).resolves.toMatchObject({
      id: "publication-a",
      sequence: 6,
      artifact: { storage: "worker_local", objectKey: null },
    });
    expect(database.calls[3]?.statement).toContain("job_publications.project_id = $3");
    expect(database.calls[3]?.parameters).toEqual(["lease-a", 4, "project-a"]);
    expect(database.calls[4]?.statement).toContain("project_id = $2");
    expect(database.calls[4]?.parameters).toEqual(["job-a", "project-a"]);
    expect(database.calls[5]?.parameters.at(-1)).toBeNull();
  });

  it("fails instead of downgrading an unauthorized private cloud upload", async () => {
    const database = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      lockedSubmissionLease(),
      submissionLease("intranet", false),
    ]);
    await expect(new JobResultService(database).publishResult(
      workerIdentity,
      "lease-a",
      2,
      { ...publicationInput, storage: "cloud_object" },
    )).rejects.toEqual(new PrivateArtifactUploadDeniedError());
    expect(database.calls).toHaveLength(3);
  });

  it("generates a tenant-qualified object key for a Job-approved private upload", async () => {
    const database = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      lockedSubmissionLease(),
      submissionLease("authorized", true),
      { rows: [] },
      { rows: [{ sequence: "6" }] },
      { rows: [artifactRow("cloud_object", "placeholder")] },
      { rows: [publicationRow()] },
    ]);
    await new JobResultService(database).publishResult(
      workerIdentity,
      "lease-a",
      2,
      { ...publicationInput, storage: "cloud_object" },
    );
    expect(database.calls[5]?.parameters[8]).toMatch(
      /^organization\/organization-a\/project\/project-a\/artifact\/[0-9a-f-]+\/1$/,
    );
  });

  it("replays an identical publication and rejects conflicting local sequence reuse", async () => {
    const stored = {
      ...publicationRow(publicationPayloadHash()),
      artifact_version: 1,
      artifact_content_hash: Buffer.alloc(32, 7),
      artifact_byte_count: "4096",
      artifact_media_type: "text/html",
      artifact_storage_kind: "worker_local" as const,
      artifact_object_key: null,
      artifact_created_at: recordedAt,
    };
    const replayDatabase = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      lockedSubmissionLease(),
      submissionLease("authorized", false),
      { rows: [stored] },
    ]);
    await expect(new JobResultService(replayDatabase).publishResult(
      workerIdentity, "lease-a", 2, publicationInput,
    )).resolves.toMatchObject({ id: "publication-a", artifact: { id: "artifact-a" } });
    expect(replayDatabase.calls).toHaveLength(4);
    expect(replayDatabase.calls[3]?.parameters).toEqual(["lease-a", 4, "project-a"]);

    const conflictDatabase = new ScriptedDatabase([
      { rows: [{ id: "session-a" }] },
      lockedSubmissionLease(),
      submissionLease(),
      { rows: [{ ...stored, publication_hash: Buffer.alloc(32, 1) }] },
    ]);
    await expect(new JobResultService(conflictDatabase).publishResult(
      workerIdentity, "lease-a", 2, publicationInput,
    )).rejects.toEqual(new JobResultIdempotencyConflictError());
  });
});

const workerUuid = "00000000-0000-4000-8000-000000000031";
const leaseUuid = "00000000-0000-4000-8000-000000000071";
const jobUuid = "00000000-0000-4000-8000-000000000061";
const requestUuid = "00000000-0000-4000-8000-000000000111";
const workerToken = "aaa.bbb.ccc";
const httpIdentity: AuthenticatedWorker = Object.freeze({
  workerId: workerUuid, projectId: "00000000-0000-4000-8000-000000000021",
  capabilityHash: Buffer.alloc(32, 3).toString("base64url"),
  sessionId: "00000000-0000-4000-8000-000000000051",
});
const httpLease: JobLease = Object.freeze({
  id: leaseUuid, jobId: jobUuid, workerId: workerUuid,
  projectId: httpIdentity.projectId, generation: 2,
  heartbeatDeadline: new Date("2026-09-02T00:00:30.000Z"),
  leaseDeadline: new Date("2026-09-02T01:00:00.000Z"),
});
const httpJob: ControlPlaneJob = Object.freeze({
  id: jobUuid, projectId: httpIdentity.projectId, idempotencyKey: "hidden", type: "read",
  input: { url: "https://example.com" },
  dataClass: "public", placement: { class: "public" as const, pinnedWorkerId: null },
  requiredCapabilities: {}, policyVersion: "v1", uploadPrivateArtifact: false, priority: 0,
  budget: {
    deadlineMs: 60_000, maxProviderAttempts: 3, maxDocumentBytes: 1_000_000,
    maxBrowserMs: 0, maxBrowserContexts: 0,
  },
  notBefore: new Date("2026-09-02T00:00:00.000Z"),
  deadlineAt: new Date("2026-09-02T01:00:00.000Z"),
  envelopeHash: resultHash, status: "assigned", resultCompleteness: null, errorCode: null,
  createdAt: new Date("2026-09-02T00:00:00.000Z"),
  updatedAt: new Date("2026-09-02T00:00:00.000Z"),
  completedAt: null,
  datasetId: null,
});

function httpRequest(path: string, body: unknown, method = "POST") {
  return {
    method,
    path,
    headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
    body,
  } as const;
}

function workerHttpHarness(options: Readonly<{
  claims?: Array<Readonly<{ job: ControlPlaneJob; lease: JobLease }> | null>;
  heartbeatError?: Error;
  publicationError?: Error;
}> = {}) {
  const calls = {
    tokens: [] as string[],
    claims: 0,
    waits: [] as number[],
    heartbeats: [] as unknown[][],
    events: [] as unknown[][],
    publications: [] as unknown[][],
    completions: [] as unknown[][],
  };
  const claims = [...(options.claims ?? [{ job: httpJob, lease: httpLease }])];
  let now = 0;
  const services = {
    identity: {
      verifySession: async (token: string) => {
        calls.tokens.push(token);
        return httpIdentity;
      },
    },
    jobs: {
      claimNext: async () => {
        calls.claims += 1;
        return claims.shift() ?? null;
      },
      heartbeat: async (...parameters: [AuthenticatedWorker, string, number]) => {
        calls.heartbeats.push(parameters);
        if (options.heartbeatError !== undefined) throw options.heartbeatError;
        return httpLease;
      },
      complete: async (...parameters: Parameters<ConstructorParameters<typeof WorkerHttpApi>[0]["jobs"]["complete"]>) => {
        calls.completions.push(parameters);
        return { ...httpJob, status: parameters[3].status } as ControlPlaneJob;
      },
    },
    results: {
      appendEvent: async (...parameters: Parameters<ConstructorParameters<typeof WorkerHttpApi>[0]["results"]["appendEvent"]>) => {
        calls.events.push(parameters);
        return {
          id: "00000000-0000-4000-8000-000000000081", projectId: httpIdentity.projectId,
          jobId: jobUuid, leaseId: leaseUuid, workerId: workerUuid, leaseGeneration: 2,
          localSequence: 3, sequence: 8, eventType: "page-fetched", pageStatus: 200,
          errorCode: null, provider: "http", byteCount: 4096, durationMs: 125,
          contentHash: resultHash,
          usage: { requests: 1 },
          occurredAt,
          recordedAt,
        };
      },
      publishResult: async (...parameters: Parameters<ConstructorParameters<typeof WorkerHttpApi>[0]["results"]["publishResult"]>) => {
        calls.publications.push(parameters);
        throw options.publicationError ?? new Error("Unexpected publication call.");
      },
    },
  } satisfies ConstructorParameters<typeof WorkerHttpApi>[0];
  return {
    api: new WorkerHttpApi(services, {
      now: () => new Date(now),
      wait: async (milliseconds) => {
        calls.waits.push(milliseconds);
        now += milliseconds;
      },
      requestId: () => requestUuid,
    }),
    calls,
  };
}

describe("Worker HTTP API", () => {
  it("publishes a contract without Worker-supplied tenant, body, credential, or object path inputs", () => {
    const contract = readFileSync(new URL("../docs/worker-control-api.openapi.yaml", import.meta.url), "utf8");
    expect(contract).toContain("openapi: 3.2.0");
    expect(contract.match(/^  \/(?:workers|job-leases)\//gmu)).toHaveLength(7);
    const eventRequest = contract.slice(contract.indexOf("    JobEventRequest:"), contract.indexOf("    JobEvent:"));
    const publicationRequest = contract.slice(
      contract.indexOf("    JobPublicationRequest:"),
      contract.indexOf("    JobPublication:"),
    );
    const uploadRequest = contract.slice(
      contract.indexOf("    ArtifactUploadRequest:"),
      contract.indexOf("    CompleteJobRequest:"),
    );
    expect(uploadRequest).toContain("artifact_id");
    expect(`${eventRequest}${publicationRequest}${uploadRequest}`).not.toMatch(
      /^\s+(project_id|body|cookie|authorization|object_key):/mu,
    );
  });

  it("requires a valid Bearer Worker Session and binds claim path identity", async () => {
    const missing = workerHttpHarness();
    const unauthorized = await missing.api.handle({
      ...httpRequest(`/v1/workers/${workerUuid}/claims`, {}),
      headers: { "content-type": "application/json" },
    });
    expect(unauthorized).toMatchObject({ status: 401, headers: { "www-authenticate": "Bearer" } });
    expect(missing.calls.tokens).toHaveLength(0);

    const mismatch = workerHttpHarness();
    const otherWorker = "00000000-0000-4000-8000-000000000032";
    const forbidden = await mismatch.api.handle(httpRequest(`/v1/workers/${otherWorker}/claims`, {}));
    expect(forbidden).toMatchObject({ status: 403, body: { code: "WORKER_PATH_IDENTITY_MISMATCH" } });
    expect(mismatch.calls.claims).toBe(0);
  });

  it("long-polls within the bound and returns a tenant-free wire Job", async () => {
    const harness = workerHttpHarness({ claims: [null, { job: httpJob, lease: httpLease }] });
    const response = await harness.api.handle(httpRequest(
      `/v1/workers/${workerUuid}/claims`, { wait_ms: 5_000 },
    ));
    expect(harness.calls.waits).toEqual([1_000]);
    expect(response).toMatchObject({
      status: 200,
      headers: { "x-request-id": requestUuid },
      body: { request_id: requestUuid, job: { id: jobUuid }, lease: { generation: 2 } },
    });
    expect(response.body).not.toHaveProperty("job.project_id");
    expect(harness.calls.tokens).toEqual([workerToken]);
  });

  it("returns 204 when no Job appears within the bounded wait", async () => {
    const harness = workerHttpHarness({ claims: [null, null, null, null] });
    await expect(harness.api.handle(httpRequest(
      `/v1/workers/${workerUuid}/claims`, { wait_ms: 2_500 },
    ))).resolves.toMatchObject({ status: 204, body: null });
    expect(harness.calls.waits).toEqual([1_000, 1_000, 500]);
  });

  it("maps strict event JSON to the existing fenced submission service", async () => {
    const harness = workerHttpHarness();
    const body = {
      generation: 2,
      local_sequence: 3,
      event_type: "page-fetched",
      page_status: 200,
      error_code: null,
      provider: "http",
      byte_count: 4096,
      duration_ms: 125,
      content_hash: resultHash,
      usage: { requests: 1 },
      occurred_at: occurredAt.toISOString(),
    };
    const response = await harness.api.handle(httpRequest(`/v1/job-leases/${leaseUuid}/events`, body));
    expect(response).toMatchObject({ status: 200, body: { event: { sequence: 8 } } });
    expect(harness.calls.events[0]).toMatchObject([
      httpIdentity,
      leaseUuid,
      2,
      { localSequence: 3, occurredAt },
    ]);

    const invalid = workerHttpHarness();
    const rejected = await invalid.api.handle(httpRequest(
      `/v1/job-leases/${leaseUuid}/events`, { ...body, object_key: "worker/controlled" },
    ));
    expect(rejected).toMatchObject({ status: 422, body: { code: "WORKER_REQUEST_INVALID" } });
    expect(invalid.calls.events).toHaveLength(0);
  });

  it("maps heartbeat fencing and private upload denial to explicit problems", async () => {
    const fenced = workerHttpHarness({ heartbeatError: new LeaseFencedError() });
    const heartbeat = await fenced.api.handle(httpRequest(
      `/v1/job-leases/${leaseUuid}`, { generation: 2 }, "PATCH",
    ));
    expect(heartbeat).toMatchObject({ status: 409, body: { code: "JOB_LEASE_FENCED" } });

    const denied = workerHttpHarness({ publicationError: new PrivateArtifactUploadDeniedError() });
    const publication = await denied.api.handle(httpRequest(
      `/v1/job-leases/${leaseUuid}/publications`,
      {
        generation: 2,
        local_sequence: 4,
        content_hash: resultHash,
        byte_count: 4096,
        media_type: "text/html",
        completeness: "complete",
        storage: "cloud_object",
      },
    ));
    expect(publication).toMatchObject({ status: 403, body: { code: "PRIVATE_ARTIFACT_UPLOAD_DENIED" } });
  });

  it("maps a consistent terminal request and rejects protocol misuse", async () => {
    const harness = workerHttpHarness();
    const completed = await harness.api.handle(httpRequest(
      `/v1/job-leases/${leaseUuid}/complete`,
      { generation: 2, status: "completed", result_completeness: "complete", error_code: null },
    ));
    expect(completed).toMatchObject({ status: 200, body: { job: { status: "completed" } } });
    expect(harness.calls.completions[0]?.[3]).toEqual({
      status: "completed",
      resultCompleteness: "complete",
      errorCode: null,
    });

    const wrongMethod = await harness.api.handle(httpRequest(
      `/v1/job-leases/${leaseUuid}`, { generation: 2 }, "POST",
    ));
    expect(wrongMethod).toMatchObject({ status: 405, headers: { allow: "PATCH" } });
    const wrongMedia = await harness.api.handle({
      ...httpRequest(`/v1/job-leases/${leaseUuid}`, { generation: 2 }, "PATCH"),
      headers: { authorization: `Bearer ${workerToken}`, "content-type": "text/plain" },
    });
    expect(wrongMedia).toMatchObject({ status: 415, body: { code: "WORKER_MEDIA_TYPE_UNSUPPORTED" } });
  });

  it.each([
    {
      field: "heartbeat generation",
      path: `/v1/job-leases/${leaseUuid}`,
      method: "PATCH",
      body: { generation: Number.MAX_SAFE_INTEGER + 1 },
      calls: "heartbeats",
    },
    ...(["generation", "local_sequence", "byte_count", "duration_ms"] as const).map((field) => ({
      field: `event ${field}`,
      path: `/v1/job-leases/${leaseUuid}/events`,
      method: "POST",
      body: {
        generation: 2,
        local_sequence: 3,
        event_type: "page-fetched",
        page_status: 200,
        error_code: null,
        provider: "http",
        byte_count: 4096,
        duration_ms: 125,
        content_hash: resultHash,
        usage: { requests: 1 },
        occurred_at: occurredAt.toISOString(),
        [field]: Number.MAX_SAFE_INTEGER + 1,
      },
      calls: "events" as const,
    })),
    ...(["generation", "local_sequence", "byte_count"] as const).map((field) => ({
      field: `publication ${field}`,
      path: `/v1/job-leases/${leaseUuid}/publications`,
      method: "POST",
      body: {
        generation: 2,
        local_sequence: 4,
        content_hash: resultHash,
        byte_count: 4096,
        media_type: "text/html",
        completeness: "complete",
        storage: "worker_local",
        [field]: Number.MAX_SAFE_INTEGER + 1,
      },
      calls: "publications" as const,
    })),
    ...(["completed", "failed"] as const).map((status) => ({
      field: `${status} completion generation`,
      path: `/v1/job-leases/${leaseUuid}/complete`,
      method: "POST",
      body: status === "completed"
        ? {
            generation: Number.MAX_SAFE_INTEGER + 1,
            status,
            result_completeness: "complete",
            error_code: null,
          }
        : {
            generation: Number.MAX_SAFE_INTEGER + 1,
            status,
            result_completeness: null,
            error_code: "WORKER_FAILED",
          },
      calls: "completions" as const,
    })),
  ] as const)("rejects unsafe $field before calling its service", async ({
    path,
    method,
    body,
    calls,
  }) => {
    const harness = workerHttpHarness();
    const response = await harness.api.handle(httpRequest(path, body, method));

    expect(response).toMatchObject({
      status: 422,
      headers: { "content-type": "application/problem+json" },
      body: { status: 422, code: "WORKER_REQUEST_INVALID", retryable: false },
    });
    expect(harness.calls[calls]).toHaveLength(0);
  });
});
