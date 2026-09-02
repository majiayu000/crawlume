import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  authenticateProjectApiKey,
  WorkerAuthenticationError,
  type AuthenticatedWorker,
} from "../src/control-plane/api-key-service.js";
import {
  JobResultService,
  listProjectAuditEvents,
} from "../src/control-plane/organization-authorization.js";
import { WorkerHttpApi } from "../src/control-plane/organization-service.js";
import {
  ControlPlaneHttpApi,
  ProjectJobHttpApi,
} from "../src/control-plane/project-http-api.js";
import {
  ControlPlaneJobService,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
} from "../src/control-plane/project-scope.js";
import { startWorkerControlServer } from "../src/server.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const apiKeyId = "44444444-4444-4444-8444-444444444444";
const workerId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";
const otherProjectId = "77777777-7777-4777-8777-777777777777";
const rawApiKey = `dya_live_deadbeef_${"A".repeat(43)}`;
const workerToken = "aaa.bbb.ccc";
const now = new Date("2026-09-02T08:00:00.000Z");
const capabilityHashBytes = Buffer.alloc(32, 8);
const contentHash = Buffer.alloc(32, 7).toString("base64url");

type StoredRow = Record<string, unknown>;

class FlowDatabase implements ControlPlaneDatabase {
  private job: StoredRow | null = null;
  private lease: StoredRow | null = null;
  private artifact: StoredRow | null = null;
  private publication: StoredRow | null = null;
  readonly auditedActions: string[] = [];

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    const sql = statement.replace(/\s+/gu, " ").trim();
    const rows = this.execute(sql, parameters);
    return { rows: rows as Row[] };
  }

  assertProjectOwnership(): void {
    expect(this.job?.project_id).toBe(projectId);
    expect(this.lease?.project_id).toBe(projectId);
    expect(this.artifact?.project_id).toBe(projectId);
    expect(this.publication?.project_id).toBe(projectId);
  }

  private execute(sql: string, parameters: readonly unknown[]): StoredRow[] {
    if (sql.startsWith("UPDATE api_keys SET last_used_at")) {
      const suppliedHash = parameters[0];
      const expectedHash = createHash("sha256").update(rawApiKey).digest();
      if (!Buffer.isBuffer(suppliedHash) || !suppliedHash.equals(expectedHash)) return [];
      return [{
        id: apiKeyId,
        project_id: projectId,
        organization_id: organizationId,
        created_by_user_id: userId,
        tasks_write: true,
        results_read: true,
        project_admin: false,
      }];
    }

    if (sql.startsWith("INSERT INTO audit_events")) {
      this.auditedActions.push(String(parameters[5]));
      return [{ id: String(parameters[0]) }];
    }

    if (sql.startsWith("INSERT INTO jobs(")) {
      this.job = {
        id: parameters[0],
        project_id: parameters[1],
        idempotency_key: parameters[2],
        type: parameters[5],
        input: JSON.parse(String(parameters[6])) as unknown,
        data_class: parameters[7],
        placement_class: parameters[8],
        pinned_worker_id: parameters[9],
        required_capabilities: JSON.parse(String(parameters[10])) as unknown,
        budget_deadline_ms: parameters[11],
        budget_max_provider_attempts: parameters[12],
        budget_max_document_bytes: parameters[13],
        budget_max_browser_ms: parameters[14],
        budget_max_browser_contexts: parameters[15],
        policy_version: parameters[16],
        upload_private_artifact: parameters[17],
        priority: parameters[18],
        not_before: parameters[19],
        deadline_at: parameters[20],
        envelope_hash: parameters[21],
        status: "queued",
        result_completeness: null,
        error_code: null,
        created_at: parameters[22],
        updated_at: parameters[22],
        completed_at: null,
      };
      return [this.job];
    }

    if (sql.startsWith("SELECT EXISTS(")) return [{ active: true }];
    if (sql.startsWith("WITH expired AS (") ||
        sql.startsWith("UPDATE jobs SET status = 'failed', error_code = 'JOB_DEADLINE_EXCEEDED'")) {
      return [];
    }

    if (sql.startsWith("SELECT jobs.* FROM jobs INNER JOIN workers")) {
      return this.job?.status === "queued" ? [this.job] : [];
    }
    if (sql.startsWith("SELECT COALESCE(MAX(generation), 0) + 1 AS generation")) {
      return [{ generation: 1 }];
    }
    if (sql.startsWith("INSERT INTO job_leases(")) {
      this.lease = {
        id: parameters[0],
        project_id: parameters[1],
        job_id: parameters[2],
        worker_id: parameters[3],
        generation: parameters[4],
        status: "active",
        heartbeat_deadline: parameters[6],
        lease_deadline: parameters[7],
      };
      return [this.lease];
    }
    if (sql.startsWith("UPDATE jobs SET status = 'running'") &&
        sql.includes("status = 'queued'")) {
      if (this.job === null || this.job.status !== "queued") return [];
      this.job = { ...this.job, status: "running", updated_at: parameters[2] };
      return [this.job];
    }
    if (sql.startsWith("UPDATE job_leases AS leases SET heartbeat_at")) {
      if (this.lease === null) return [];
      this.lease = { ...this.lease, heartbeat_deadline: parameters[5] };
      return [this.lease];
    }
    if (sql.startsWith("UPDATE jobs SET status = 'running'")) {
      if (this.job === null) return [];
      this.job = { ...this.job, status: "running", updated_at: parameters[2] };
      return [{ id: String(this.job.id) }];
    }
    if (sql.startsWith("UPDATE job_leases SET status = 'completed'")) {
      if (this.lease === null || this.lease.status !== "active" ||
          this.lease.id !== parameters[0] || this.lease.worker_id !== parameters[1] ||
          this.lease.project_id !== parameters[2] || this.lease.generation !== parameters[3]) {
        return [];
      }
      this.lease = { ...this.lease, status: "completed", finished_at: parameters[4] };
      return [this.lease];
    }
    if (sql.startsWith("UPDATE jobs SET status = $3")) {
      if (this.job === null || this.job.status !== "running" ||
          this.job.id !== parameters[0] || this.job.project_id !== parameters[1]) {
        return [];
      }
      this.job = {
        ...this.job,
        status: parameters[2],
        result_completeness: parameters[3],
        error_code: parameters[4],
        completed_at: parameters[5],
        updated_at: parameters[5],
      };
      return [this.job];
    }

    if (sql.startsWith("SELECT worker_sessions.id FROM worker_sessions")) {
      return [{ id: sessionId }];
    }
    if (sql.startsWith("SELECT jobs.id AS job_id, projects.organization_id")) {
      if (this.job?.status !== "running") return [];
      return [{
        job_id: this.job.id,
        organization_id: organizationId,
        data_class: this.job.data_class,
        upload_private_artifact: this.job.upload_private_artifact,
      }];
    }
    if (sql.includes("WHERE job_publications.lease_id = $1")) {
      return this.publication === null ? [] : [this.existingPublication()];
    }
    if (sql.startsWith("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence") &&
        sql.includes("FROM job_publications")) {
      return [{ sequence: 1 }];
    }
    if (sql.startsWith("INSERT INTO artifact_metadata(")) {
      this.artifact = {
        id: parameters[0],
        project_id: parameters[1],
        job_id: parameters[2],
        version: parameters[3],
        content_hash: parameters[4],
        byte_count: parameters[5],
        media_type: parameters[6],
        storage_kind: parameters[7],
        object_key: parameters[8],
        created_at: now,
      };
      return [this.artifact];
    }
    if (sql.startsWith("INSERT INTO job_publications(")) {
      this.publication = {
        id: parameters[0],
        project_id: parameters[1],
        job_id: parameters[2],
        lease_id: parameters[3],
        worker_id: parameters[4],
        lease_generation: parameters[5],
        local_sequence: parameters[6],
        sequence: parameters[7],
        publication_hash: parameters[8],
        artifact_id: parameters[9],
        result_completeness: parameters[10],
        recorded_at: now,
      };
      return [this.publication];
    }
    if (sql.startsWith("SELECT id FROM jobs WHERE id = $1 AND project_id = $2")) {
      const job = this.job;
      if (job === null || job.id !== parameters[0] || job.project_id !== parameters[1]) return [];
      return [{ id: String(job.id) }];
    }
    if (sql.includes("WHERE job_publications.project_id = $1")) {
      return this.publication === null ? [] : [this.existingPublication()];
    }

    throw new Error(`FlowDatabase received unexpected SQL: ${sql}`);
  }

  private existingPublication(): StoredRow {
    if (this.publication === null || this.artifact === null) {
      throw new Error("Publication and Artifact state must both exist.");
    }
    return {
      ...this.publication,
      artifact_id: this.artifact.id,
      artifact_version: this.artifact.version,
      artifact_content_hash: this.artifact.content_hash,
      artifact_byte_count: this.artifact.byte_count,
      artifact_media_type: this.artifact.media_type,
      artifact_storage_kind: this.artifact.storage_kind,
      artifact_object_key: this.artifact.object_key,
      artifact_created_at: this.artifact.created_at,
    };
  }
}

describe("control-plane Project and Worker integration", () => {
  it("carries one Project-scoped Job from claim through publication and completion", async () => {
    const database = new FlowDatabase();
    const jobs = new ControlPlaneJobService(database, { now: () => now });
    const results = new JobResultService(database);
    const workerIdentity: AuthenticatedWorker = Object.freeze({
      workerId,
      projectId,
      sessionId,
      capabilityHash: capabilityHashBytes.toString("base64url"),
    });
    const projects = new ProjectJobHttpApi({
      authenticate: (key, context) => authenticateProjectApiKey(database, key, context),
      createJob: jobs.createJob.bind(jobs),
      getJob: jobs.getJob.bind(jobs),
      cancelJob: jobs.cancel.bind(jobs),
      listPublications: results.listPublications.bind(results),
      listAuditEvents: (identity, input) => listProjectAuditEvents(database, identity, input),
    });
    const workers = new WorkerHttpApi({
      identity: {
        verifySession: async (token: string) => {
          if (token !== workerToken) throw new WorkerAuthenticationError();
          return workerIdentity;
        },
      },
      jobs,
      results,
    }, { now: () => now });
    const listener = await startWorkerControlServer(
      new ControlPlaneHttpApi(projects, workers),
      { host: "127.0.0.1", port: 0, tls: null },
    );

    try {
      const createdResponse = await fetch(`${listener.origin}/v1/projects/${projectId}/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${rawApiKey}`,
          "content-type": "application/json",
          "idempotency-key": "integration-flow-1",
        },
        body: JSON.stringify({
          type: "read",
          input: { url: "https://example.com" },
          data_class: "public",
          placement: { class: "public", pinned_worker_id: null },
          required_capabilities: {},
          budget: {
            deadline_ms: 300_000,
            max_provider_attempts: 2,
            max_document_bytes: 1_000_000,
            max_browser_ms: 0,
            max_browser_contexts: 0,
          },
          policy_version: "integration-v1",
          upload_private_artifact: false,
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { job: { id: string; status: string } };
      expect(created.job.status).toBe("queued");

      const claimResponse = await fetch(`${listener.origin}/v1/workers/${workerId}/claims`, {
        method: "POST",
        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ wait_ms: 0 }),
      });
      expect(claimResponse.status).toBe(200);
      const claim = await claimResponse.json() as {
        job: { id: string; status: string };
        lease: { id: string; generation: number };
      };
      expect(claim.job).toMatchObject({
        id: created.job.id,
        status: "running",
      });

      const publicationResponse = await fetch(
        `${listener.origin}/v1/job-leases/${claim.lease.id}/publications`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            generation: claim.lease.generation,
            local_sequence: 1,
            content_hash: contentHash,
            byte_count: 1234,
            media_type: "text/markdown",
            completeness: "complete",
            storage: "worker_local",
          }),
        },
      );
      expect(publicationResponse.status).toBe(200);

      const completionResponse = await fetch(
        `${listener.origin}/v1/job-leases/${claim.lease.id}/complete`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            generation: claim.lease.generation,
            status: "completed",
            result_completeness: "complete",
            error_code: null,
          }),
        },
      );
      expect(completionResponse.status).toBe(200);
      await expect(completionResponse.json()).resolves.toMatchObject({
        job: { id: created.job.id, status: "completed" },
      });

      const listedResponse = await fetch(
        `${listener.origin}/v1/projects/${projectId}/jobs/${created.job.id}/publications?limit=10`,
        { headers: { authorization: `Bearer ${rawApiKey}` } },
      );
      expect(listedResponse.status).toBe(200);
      const listed = await listedResponse.json() as {
        publications: Array<{
          job_id: string;
          artifact: { content_hash: string; storage: string; object_key: string | null };
        }>;
        pagination: { has_more: boolean; next_sequence: number | null };
      };
      expect(listed.publications).toEqual([
        expect.objectContaining({
          job_id: created.job.id,
          artifact: expect.objectContaining({
            content_hash: contentHash,
            storage: "worker_local",
            object_key: null,
          }),
        }),
      ]);
      expect(listed.pagination).toEqual({ has_more: false, next_sequence: 1, limit: 10 });

      const crossProjectResponse = await fetch(
        `${listener.origin}/v1/projects/${otherProjectId}/jobs/${created.job.id}/publications`,
        { headers: { authorization: `Bearer ${rawApiKey}` } },
      );
      expect(crossProjectResponse.status).toBe(403);
      await expect(crossProjectResponse.json()).resolves.toMatchObject({
        code: "PROJECT_PATH_IDENTITY_MISMATCH",
      });
      database.assertProjectOwnership();
      expect(database.auditedActions).toEqual([
        "api_key.used",
        "api_key.used",
        "api_key.used",
      ]);
    } finally {
      await listener.close();
    }
  });
});
