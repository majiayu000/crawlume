import { describe, expect, it } from "vitest";

import {
  ControlPlaneJobService,
  getScopedProject,
  JobIdempotencyConflictError,
  JobTransitionError,
  JobWorkerAccessDeniedError,
  LeaseFencedError,
  ProjectAccessDeniedError,
  resolveProjectScope,
  type ControlPlaneDatabase,
  type ControlPlaneJobRequest,
  type ControlPlaneQuery,
  type CreateControlPlaneJobInput,
  type ProjectScope,
} from "../src/control-plane/project-scope.js";
import type {
  AuthenticatedProjectApiKey,
  AuthenticatedWorker,
} from "../src/control-plane/api-key-service.js";

type Membership = {
  organizationId: string;
  projectId: string;
  role: "owner" | "admin" | "member";
  userId: string;
};

type Project = {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
};

class TenantDatabase implements ControlPlaneQuery {
  readonly calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];

  constructor(
    private readonly memberships: Membership[],
    private readonly projects: Project[],
  ) {}

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.calls.push({ statement, parameters });
    if (statement.includes("organization_memberships.user_id = $2")) {
      const [projectId, userId] = parameters;
      const membership = this.memberships.find((candidate) =>
        candidate.projectId === projectId && candidate.userId === userId
      );
      return {
        rows: membership === undefined ? [] : [{
          project_id: membership.projectId,
          organization_id: membership.organizationId,
          role: membership.role,
        } as Row],
      };
    }

    if (statement.includes("WHERE id = $1 AND organization_id = $2")) {
      const [projectId, organizationId] = parameters;
      const project = this.projects.find((candidate) =>
        candidate.id === projectId && candidate.organizationId === organizationId
      );
      return {
        rows: project === undefined ? [] : [{
          id: project.id,
          organization_id: project.organizationId,
          slug: project.slug,
          name: project.name,
        } as Row],
      };
    }

    throw new Error("Unexpected control-plane query.");
  }
}

const projects: Project[] = [
  { id: "project-a", organizationId: "organization-a", slug: "alpha", name: "Alpha" },
  { id: "project-b", organizationId: "organization-b", slug: "beta", name: "Beta" },
];

const memberships: Membership[] = [
  {
    organizationId: "organization-a",
    projectId: "project-a",
    role: "owner",
    userId: "user-a",
  },
  {
    organizationId: "organization-b",
    projectId: "project-b",
    role: "owner",
    userId: "user-b",
  },
];

describe("ProjectScope", () => {
  it("derives organization and role from the authenticated membership", async () => {
    const database = new TenantDatabase(memberships, projects);

    const scope = await resolveProjectScope(database, { userId: "user-a" }, "project-a");

    expect(scope).toMatchObject({
      userId: "user-a",
      projectId: "project-a",
      organizationId: "organization-a",
      role: "owner",
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(database.calls[0]?.parameters).toEqual(["project-a", "user-a"]);
  });

  it("returns the same denial for an unknown project and another tenant's project", async () => {
    const database = new TenantDatabase(memberships, projects);

    await expect(resolveProjectScope(
      database,
      { userId: "user-a" },
      "project-b",
    )).rejects.toEqual(new ProjectAccessDeniedError());
    await expect(resolveProjectScope(
      database,
      { userId: "user-a" },
      "project-unknown",
    )).rejects.toEqual(new ProjectAccessDeniedError());
  });

  it("does not accept a caller-provided organization identifier", async () => {
    const database = new TenantDatabase(memberships, projects);
    const untrustedInput = {
      projectId: "project-a",
      organizationId: "organization-b",
    };

    const scope = await resolveProjectScope(
      database,
      { userId: "user-a" },
      untrustedInput.projectId,
    );

    expect(scope.organizationId).toBe("organization-a");
    expect(scope.organizationId).not.toBe(untrustedInput.organizationId);
  });

  it("binds project reads to both identifiers in the trusted scope", async () => {
    const database = new TenantDatabase(memberships, projects);
    const scope = await resolveProjectScope(database, { userId: "user-a" }, "project-a");

    await expect(getScopedProject(database, scope)).resolves.toEqual(projects[0]);
    expect(database.calls[1]?.parameters).toEqual(["project-a", "organization-a"]);
  });

  it("rejects malformed identity inputs before querying", async () => {
    const database = new TenantDatabase(memberships, projects);

    await expect(resolveProjectScope(database, { userId: " " }, "project-a"))
      .rejects.toThrow("subject.userId must be a non-empty string");
    await expect(resolveProjectScope(database, { userId: "user-a" }, " "))
      .rejects.toThrow("projectId must be a non-empty string");
    expect(database.calls).toHaveLength(0);
  });
});

type JobCall = { statement: string; parameters: readonly unknown[] };
type JobResponse = { rows: unknown[] } | ((call: JobCall) => { rows: unknown[] });

class JobDatabase implements ControlPlaneDatabase {
  readonly calls: JobCall[] = [];
  transactions = 0;

  constructor(private readonly responses: JobResponse[]) {}

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    return operation(this);
  }

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    const call = { statement, parameters };
    this.calls.push(call);
    const next = statement.includes("INSERT INTO audit_events")
      ? { rows: [{ id: "audit-event" }] } : this.responses.shift();
    if (next === undefined) throw new Error("Unexpected Job query.");
    return (typeof next === "function" ? next(call) : next) as { rows: Row[] };
  }
}

const jobNow = new Date("2026-09-01T14:00:00.000Z");
const jobCapabilityHash = Buffer.alloc(32, 7);
const jobAuditContext = { correlationId: "correlation-job-a" };

async function jobScope(): Promise<ProjectScope> {
  return resolveProjectScope(
    new TenantDatabase(memberships, projects),
    { userId: "user-a" },
    "project-a",
  );
}

function jobInput(overrides: object = {}): CreateControlPlaneJobInput {
  return {
    type: "crawl",
    input: { url: "https://example.com", maxDepth: 2 },
    dataClass: "public",
    placement: { class: "public", pinnedWorkerId: null },
    requiredCapabilities: { browser: true },
    budget: {
      deadlineMs: 300_000,
      maxProviderAttempts: 100,
      maxDocumentBytes: 50_000_000,
      maxBrowserMs: 120_000,
      maxBrowserContexts: 20,
    },
    policyVersion: "sha256:policy-a",
    uploadPrivateArtifact: false,
    ...overrides,
  } as CreateControlPlaneJobInput;
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-a",
    project_id: "project-a",
    idempotency_key: "request-a",
    type: "crawl",
    input: { maxDepth: 2, url: "https://example.com" },
    data_class: "public",
    placement_class: "public",
    pinned_worker_id: null,
    required_capabilities: { browser: true },
    budget_deadline_ms: 300_000,
    budget_max_provider_attempts: 100,
    budget_max_document_bytes: 50_000_000,
    budget_max_browser_ms: 120_000,
    budget_max_browser_contexts: 20,
    policy_version: "sha256:policy-a",
    upload_private_artifact: false,
    priority: 0,
    not_before: jobNow,
    deadline_at: new Date(jobNow.getTime() + 300_000),
    envelope_hash: Buffer.alloc(32, 9),
    status: "queued",
    result_completeness: null,
    error_code: null,
    created_at: jobNow,
    updated_at: jobNow,
    completed_at: null,
    ...overrides,
  };
}

function workerIdentity(overrides: Partial<AuthenticatedWorker> = {}): AuthenticatedWorker {
  return {
    workerId: "worker-a",
    projectId: "project-a",
    capabilityHash: jobCapabilityHash.toString("base64url"),
    sessionId: "session-a",
    ...overrides,
  };
}

describe("control-plane Job creation", () => {
  it("keeps the public TypeScript Job type and input contract correlated", () => {
    const readJob: CreateControlPlaneJobInput = {
      type: "read",
      input: { url: "https://example.com" },
      dataClass: "public",
      placement: { class: "public", pinnedWorkerId: null },
      requiredCapabilities: {},
      budget: {
        deadlineMs: 1,
        maxProviderAttempts: 1,
        maxDocumentBytes: 1,
        maxBrowserMs: 0,
        maxBrowserContexts: 0,
      },
      policyVersion: "v1",
      uploadPrivateArtifact: false,
    };
    // @ts-expect-error A read Job cannot carry search input.
    const mismatchedJob: CreateControlPlaneJobInput = { ...readJob, input: { query: "unsafe" } };

    expect(readJob.type).toBe("read");
    expect(mismatchedJob.input).toEqual({ query: "unsafe" });
  });

  it("accepts the documented strict input contract for every public Job type", async () => {
    const cases: ControlPlaneJobRequest[] = [
      {
        type: "read",
        input: {
          url: "https://example.com/read",
          browserAllowed: true,
          cacheMode: "live",
          maxAgeSeconds: 60,
          browserReadiness: {
            target: { selector: "main", state: "visible", minCount: 1 },
            interaction: { type: "scroll-to-end", maxSteps: 2, stepDelayMs: 10 },
            timeoutMs: 1_000,
          },
        },
      },
      { type: "inspect", input: { url: "http://example.com/inspect", browserAllowed: false } },
      {
        type: "map",
        input: {
          url: "https://example.com/map",
          browserAllowed: true,
          maxPages: 500,
          maxDepth: 10,
          includeSubdomains: true,
          ignoreQueryParameters: false,
        },
      },
      {
        type: "crawl",
        input: {
          url: "https://example.com/crawl",
          browserAllowed: true,
          cacheMode: "prefer-cache",
          maxAgeSeconds: 300,
          maxPages: 10_000,
          maxDepth: 10,
          includeSubdomains: false,
          ignoreQueryParameters: true,
          concurrency: 32,
        },
      },
      {
        type: "search",
        input: {
          query: "distributed systems",
          limit: 20,
          page: 100,
          language: "zh-CN",
          safeSearch: 2,
          timeRange: "month",
          source: "auto",
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const database = new JobDatabase([
        (call) => ({ rows: [jobRow({
          id: call.parameters[0],
          idempotency_key: call.parameters[2],
          type: call.parameters[5],
          input: JSON.parse(String(call.parameters[6])) as unknown,
          required_capabilities: JSON.parse(String(call.parameters[10])) as unknown,
          budget_deadline_ms: call.parameters[11],
          budget_max_provider_attempts: call.parameters[12],
          budget_max_document_bytes: call.parameters[13],
          budget_max_browser_ms: call.parameters[14],
          budget_max_browser_contexts: call.parameters[15],
          envelope_hash: call.parameters[21],
          not_before: call.parameters[19],
          deadline_at: call.parameters[20],
          created_at: call.parameters[22],
          updated_at: call.parameters[22],
        })] }),
      ]);
      const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });
      const budget = index === 0 ? {
        deadlineMs: 86_400_000,
        maxProviderAttempts: 1_000_000,
        maxDocumentBytes: Number.MAX_SAFE_INTEGER,
        maxBrowserMs: 86_400_000,
        maxBrowserContexts: 100_000,
      } : jobInput().budget;

      const created = await service.createJob(
        await jobScope(),
        `valid-${index}`,
        jobInput({
          ...testCase,
          budget,
          requiredCapabilities: index === 0 ? {} : { browser: true },
        }),
        jobAuditContext,
      );

      expect(created).toMatchObject(testCase);
      expect(created.budget).toEqual(budget);
      expect(created.requiredCapabilities).toEqual(index === 0 ? {} : { browser: true });
      expect(database.calls).toHaveLength(1);
    }
  });

  it("rejects every Job budget above its public limit before the database", async () => {
    const baseline = jobInput().budget;
    const overLimits: Array<Partial<typeof baseline>> = [
      { deadlineMs: 86_400_001 },
      { maxProviderAttempts: 1_000_001 },
      { maxDocumentBytes: Number.MAX_SAFE_INTEGER + 1 },
      { maxBrowserMs: 86_400_001 },
      { maxBrowserContexts: 100_001 },
    ];

    for (const overLimit of overLimits) {
      const database = new JobDatabase([]);
      const service = new ControlPlaneJobService(database);
      await expect(service.createJob(
        await jobScope(),
        "over-budget",
        jobInput({ budget: { ...baseline, ...overLimit } }),
        jobAuditContext,
      )).rejects.toBeInstanceOf(TypeError);
      expect(database.calls).toHaveLength(0);
    }
  });

  it("rejects unknown, cross-type, credential-bearing, and undefined inputs before the database", async () => {
    const rejectedInputs: Array<Readonly<{
      type: string;
      input: Record<string, unknown>;
      requiredCapabilities?: Record<string, unknown>;
    }>> = [
      { type: "read", input: { url: "https://example.com", headers: { authorization: "secret" } } },
      { type: "read", input: { url: "https://example.com", cookie: "session=secret" } },
      { type: "read", input: { url: "https://example.com", body: "secret" } },
      { type: "read", input: { url: "https://example.com", unknown: "secret" } },
      { type: "read", input: { url: "https://example.com", maxPages: 2 } },
      { type: "map", input: { url: "https://example.com", cacheMode: "live" } },
      { type: "crawl", input: { url: "https://example.com", crawlBudget: {} } },
      { type: "crawl", input: { url: "https://example.com", staleWhileRevalidateSeconds: 1 } },
      { type: "inspect", input: { url: "https://user:secret@example.com/private" } },
      { type: "inspect", input: { url: "https://@example.com/private" } },
      { type: "inspect", input: { url: "https://:@example.com/private" } },
      { type: "inspect", input: { url: "HTTPS://example.com/private" } },
      { type: "inspect", input: { url: " https://example.com/private" } },
      { type: "inspect", input: { url: "https://example.com/private " } },
      { type: "read", input: { url: "https://example.com", maxAgeSeconds: 9_007_199_254_740_992 } },
      { type: "search", input: { query: "   " } },
      { type: "read", input: {
        url: "https://example.com", browserReadiness: { target: { selector: "   " } },
      } },
      {
        type: "read", input: { url: "https://example.com" },
        requiredCapabilities: { headers: { authorization: "secret-capability" } },
      },
      {
        type: "read", input: { url: "https://example.com" },
        requiredCapabilities: { cookie: "secret-capability" },
      },
      {
        type: "read", input: { url: "https://example.com" },
        requiredCapabilities: { authProfile: "secret-capability" },
      },
      { type: "monitor-run", input: { url: "https://example.com" } },
      { type: "vertical-index-run", input: { query: "secret-value" } },
    ];

    for (const rejected of rejectedInputs) {
      const database = new JobDatabase([]);
      const service = new ControlPlaneJobService(database);
      let failure: unknown;
      try {
        await service.createJob(
          await jobScope(),
          "rejected",
          jobInput({
            type: rejected.type,
            input: rejected.input,
            ...(rejected.requiredCapabilities === undefined
              ? {}
              : { requiredCapabilities: rejected.requiredCapabilities }),
          }),
          jobAuditContext,
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(TypeError);
      expect(String(failure)).not.toContain("secret");
      expect(database.calls).toHaveLength(0);
    }
  });

  it("uses a canonical Project-scoped idempotency hash and returns the original Job on retry", async () => {
    let currentTime = new Date(jobNow);
    const returned = jobRow();
    const database = new JobDatabase([
      (call) => ({ rows: [{
        ...returned,
        id: call.parameters[0],
        project_id: call.parameters[1],
        idempotency_key: call.parameters[2],
        envelope_hash: call.parameters[21],
        created_at: call.parameters[22],
        updated_at: call.parameters[22],
        not_before: call.parameters[19],
        deadline_at: call.parameters[20],
      }] }),
      { rows: [returned] },
    ]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(currentTime) });
    const scope = await jobScope();
    const first = await service.createJob(scope, "request-a", jobInput(), jobAuditContext);
    currentTime = new Date(jobNow.getTime() + 5_000);
    const second = await service.createJob(scope, "request-a", jobInput({
      input: { maxDepth: 2, url: "https://example.com" },
    }), jobAuditContext);

    expect(first.projectId).toBe("project-a");
    expect(second.id).toBe("job-a");
    expect(database.calls[0]?.statement).toContain(
      "ON CONFLICT (project_id, idempotency_key)",
    );
    expect(database.calls[0]?.parameters[3]).toEqual(database.calls[1]?.parameters[3]);
    expect(database.calls[0]?.parameters[1]).toBe("project-a");
    expect(first.deadlineAt.getTime() - first.createdAt.getTime()).toBe(300_000);
  });

  it("returns an explicit conflict when the same key has a different request hash", async () => {
    const database = new JobDatabase([{ rows: [] }]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });

    await expect(service.createJob(await jobScope(), "request-a", jobInput({
      input: { url: "https://different.example" },
    }), jobAuditContext)).rejects.toEqual(new JobIdempotencyConflictError());
  });

  it("rejects private data on public placement before touching the database", async () => {
    const database = new JobDatabase([]);
    const service = new ControlPlaneJobService(database);

    await expect(service.createJob(await jobScope(), "request-a", jobInput({
      dataClass: "authorized",
      placement: { class: "public", pinnedWorkerId: null },
    }), jobAuditContext)).rejects.toThrow("require private placement");
    expect(database.calls).toHaveLength(0);
  });

  it("audits private creation and one-Job upload approval only on the first request", async () => {
    let created: Record<string, unknown> | undefined;
    const database = new JobDatabase([
      (call) => {
        created = jobRow({
          id: call.parameters[0], data_class: "authorized", placement_class: "private",
          upload_private_artifact: true,
        });
        return { rows: [created] };
      },
      () => ({ rows: [created] }),
    ]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });
    const input = jobInput({
      dataClass: "authorized",
      placement: { class: "private", pinnedWorkerId: null },
      uploadPrivateArtifact: true,
    });
    const scope = await jobScope();

    const first = await service.createJob(scope, "private-a", input, jobAuditContext);
    const replay = await service.createJob(scope, "private-a", input, jobAuditContext);

    expect(replay.id).toBe(first.id);
    const audits = database.calls.filter((call) => call.statement.includes("INSERT INTO audit_events"));
    expect(audits.map((call) => call.parameters[5])).toEqual([
      "private_job.created", "private_artifact_upload.approved",
    ]);
    expect(JSON.stringify(audits)).not.toContain("https://example.com");
  });

  it("records an API Key as the actor while retaining its creator as the responsible user", async () => {
    const database = new JobDatabase([
      (call) => ({ rows: [jobRow({
        id: call.parameters[0], data_class: "authorized", placement_class: "private",
      })] }),
    ]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });
    const apiKey: AuthenticatedProjectApiKey = Object.freeze({
      apiKeyId: "key-a",
      projectId: "project-a",
      organizationId: "organization-a",
      createdByUserId: "user-a",
      scopes: ["tasks:write"] as const,
    });

    await service.createJob(apiKey, "private-api-key", jobInput({
      dataClass: "authorized",
      placement: { class: "private", pinnedWorkerId: null },
    }), jobAuditContext);

    expect(database.calls[0]?.parameters[4]).toBe("user-a");
    const audit = database.calls.find((call) => call.statement.includes("INSERT INTO audit_events"));
    expect(audit?.parameters.slice(3, 6)).toEqual([
      "api_key", "key-a", "private_job.created",
    ]);
  });

  it("binds Job reads to the trusted ProjectScope", async () => {
    const database = new JobDatabase([{ rows: [] }]);
    const service = new ControlPlaneJobService(database);

    await expect(service.getJob(await jobScope(), "job-b"))
      .rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    expect(database.calls[0]?.parameters).toEqual(["job-b", "project-a"]);
  });
});

describe("control-plane Worker claim", () => {
  it("revalidates the Worker session and claims a running Job with generation fencing", async () => {
    const running = jobRow({ status: "running" });
    const database = new JobDatabase([
      { rows: [{ active: true }] },
      { rows: [] },
      { rows: [] },
      { rows: [jobRow()] },
      { rows: [{ generation: "2" }] },
      { rows: [{
        id: "lease-b",
        project_id: "project-a",
        job_id: "job-a",
        worker_id: "worker-a",
        generation: "2",
        heartbeat_deadline: new Date(jobNow.getTime() + 30_000),
        lease_deadline: new Date(jobNow.getTime() + 300_000),
      }] },
      { rows: [running] },
    ]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });
    const claimed = await service.claimNext(workerIdentity());

    expect(claimed?.job.status).toBe("running");
    expect(claimed?.lease).toMatchObject({ generation: 2, projectId: "project-a" });
    expect(database.calls[3]?.statement).toContain("FOR UPDATE OF jobs SKIP LOCKED");
    expect(database.calls[3]?.statement).toContain("capability_manifest @>");
    expect(database.calls[3]?.statement).toContain("workers.kind = 'private'");
    expect(database.calls[3]?.parameters.slice(0, 2)).toEqual(["worker-a", "project-a"]);
    expect(database.calls[3]?.parameters[2]).toEqual(jobCapabilityHash);
    expect(database.calls[4]?.statement).toContain("project_id = $2");
    expect(database.calls[4]?.parameters).toEqual(["job-a", "project-a"]);
    expect(database.calls[5]?.parameters.slice(1, 4)).toEqual([
      "project-a", "job-a", "worker-a",
    ]);
    expect(database.calls[6]?.statement).toContain("status = 'running'");
  });

  it("returns no work without weakening authentication failures into an empty queue", async () => {
    const invalidDatabase = new JobDatabase([{ rows: [{ active: false }] }]);
    const invalid = new ControlPlaneJobService(invalidDatabase);
    await expect(invalid.claimNext(workerIdentity({ projectId: "project-b" })))
      .rejects.toEqual(new JobWorkerAccessDeniedError());
    expect(invalidDatabase.calls).toHaveLength(1);

    const emptyDatabase = new JobDatabase([
      { rows: [{ active: true }] }, { rows: [] }, { rows: [] }, { rows: [] },
    ]);
    const empty = new ControlPlaneJobService(emptyDatabase);
    await expect(empty.claimNext(workerIdentity())).resolves.toBeNull();
  });

  it("heartbeats only the exact active generation and transitions assigned to running", async () => {
    const database = new JobDatabase([
      { rows: [{ active: true }] },
      { rows: [{
        id: "lease-b",
        project_id: "project-a",
        job_id: "job-a",
        worker_id: "worker-a",
        generation: "2",
        heartbeat_deadline: new Date(jobNow.getTime() + 30_000),
        lease_deadline: new Date(jobNow.getTime() + 300_000),
      }] },
      { rows: [{ id: "job-a" }] },
    ]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });
    const lease = await service.heartbeat(workerIdentity(), "lease-b", 2);

    expect(lease.generation).toBe(2);
    expect(database.calls[1]?.parameters.slice(0, 4)).toEqual([
      "lease-b", "worker-a", "project-a", 2,
    ]);
    expect(database.calls[2]?.statement).toContain("status = 'running'");
  });

  it("rejects an old generation without updating the Job", async () => {
    const database = new JobDatabase([{ rows: [{ active: true }] }, { rows: [] }]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });

    await expect(service.heartbeat(workerIdentity(), "lease-a", 1))
      .rejects.toEqual(new LeaseFencedError());
    expect(database.calls).toHaveLength(2);
  });
});

describe("control-plane Job completion and controls", () => {
  it("allows only the current lease to commit a complete or partial terminal outcome", async () => {
    const database = new JobDatabase([
      { rows: [{ active: true }] },
      { rows: [{
        id: "lease-b",
        project_id: "project-a",
        job_id: "job-a",
        worker_id: "worker-a",
        generation: 2,
        heartbeat_deadline: new Date(jobNow.getTime() + 30_000),
        lease_deadline: new Date(jobNow.getTime() + 300_000),
      }] },
      { rows: [jobRow({
        status: "completed",
        result_completeness: "partial",
        completed_at: jobNow,
      })] },
    ]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });
    const completed = await service.complete(workerIdentity(), "lease-b", 2, {
      status: "completed",
      resultCompleteness: "partial",
      errorCode: null,
    });

    expect(completed).toMatchObject({ status: "completed", resultCompleteness: "partial" });
    expect(database.calls[1]?.parameters.slice(0, 4)).toEqual([
      "lease-b", "worker-a", "project-a", 2,
    ]);
    expect(database.calls[2]?.parameters[1]).toBe("project-a");
    expect(database.calls[2]?.statement).toContain("status = 'running'");
  });

  it("rejects inconsistent terminal input before authenticating the Worker", async () => {
    const database = new JobDatabase([]);
    const service = new ControlPlaneJobService(database);

    await expect(service.complete(workerIdentity(), "lease-a", 1, {
      status: "failed",
      resultCompleteness: null,
      errorCode: " ",
    })).rejects.toThrow("terminal payload is inconsistent");
    expect(database.calls).toHaveLength(0);
  });

  it.each([
    ["old generation", workerIdentity(), 1],
    ["wrong Worker", workerIdentity({ workerId: "worker-b" }), 2],
    ["wrong Project", workerIdentity({ projectId: "project-b" }), 2],
  ])("fences completion for the %s", async (_case, identity, generation) => {
    const database = new JobDatabase([{ rows: [{ active: true }] }, { rows: [] }]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });

    await expect(service.complete(identity, "lease-b", generation, {
      status: "completed",
      resultCompleteness: "complete",
      errorCode: null,
    })).rejects.toEqual(new LeaseFencedError());
    expect(database.calls[1]?.parameters.slice(0, 4)).toEqual([
      "lease-b", identity.workerId, identity.projectId, generation,
    ]);
    expect(database.calls).toHaveLength(2);
  });

  it("pauses, resumes, and cancels only inside the trusted Project", async () => {
    const database = new JobDatabase([
      { rows: [jobRow({ status: "paused" })] },
      { rows: [{ id: "lease-a" }] },
      { rows: [jobRow({ status: "queued" })] },
      { rows: [jobRow({ status: "cancelled", completed_at: jobNow })] },
      { rows: [] },
    ]);
    const service = new ControlPlaneJobService(database, { now: () => new Date(jobNow) });
    const scope = await jobScope();

    await expect(service.pause(scope, "job-a")).resolves.toMatchObject({ status: "paused" });
    await expect(service.resume(scope, "job-a")).resolves.toMatchObject({ status: "queued" });
    await expect(service.cancel(scope, "job-a")).resolves.toMatchObject({ status: "cancelled" });
    expect(database.calls[0]?.parameters.slice(0, 2)).toEqual(["job-a", "project-a"]);
    expect(database.calls[2]?.parameters.slice(0, 2)).toEqual(["job-a", "project-a"]);
    expect(database.calls[3]?.parameters.slice(0, 2)).toEqual(["job-a", "project-a"]);
  });

  it("uses one transition error for another Project and an invalid state", async () => {
    const database = new JobDatabase([{ rows: [] }]);
    const service = new ControlPlaneJobService(database);

    await expect(service.cancel(await jobScope(), "job-b"))
      .rejects.toEqual(new JobTransitionError());
    expect(database.calls[0]?.parameters.slice(0, 2)).toEqual(["job-b", "project-a"]);
  });
});
