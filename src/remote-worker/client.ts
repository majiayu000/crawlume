import { z } from "zod";

import {
  parseControlPlaneJobCreation,
  type ControlPlaneJobRequest,
  type ControlPlaneRequiredCapabilities,
} from "../control-plane/job-input.js";
import { workerSigningPayload } from "../control-plane/worker-challenge-budget.js";
import type { InMemoryWorkerIdentity } from "./enrollment.js";

const uuidSchema = z.uuid();
const enrollmentTokenSchema = z.string().regex(/^dya_we_[A-Za-z0-9_-]{43}$/u);
const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
const versionSchema = z.string().trim().min(1).max(128);
const generationSchema = z.number().int().positive().safe();
const dateTimeSchema = z.string().datetime({ offset: true });
const capabilityManifestSchema = z.record(z.string(), z.unknown()).refine((value) => {
  try {
    const json = JSON.stringify(value);
    return json !== undefined && Buffer.byteLength(json) <= 16 * 1_024;
  } catch {
    return false;
  }
});

const workerSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  name: z.string(),
  kind: z.enum(["public", "private"]),
  version: z.string(),
  capability_hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  status: z.enum(["active", "disabled"]),
  created_by_user_id: uuidSchema,
  created_at: dateTimeSchema,
  disabled_at: dateTimeSchema.nullable(),
}).strict();

const workerResponseSchema = z.object({
  request_id: uuidSchema,
  worker: workerSchema,
}).strict();

const challengeResponseSchema = z.object({
  request_id: uuidSchema,
  challenge: z.object({
    worker_id: uuidSchema,
    challenge: z.string().regex(/^dya_wc_[A-Za-z0-9_-]{43}$/u),
    signing_payload: z.string(),
    expires_at: dateTimeSchema,
  }).strict(),
}).strict();

const sessionResponseSchema = z.object({
  request_id: uuidSchema,
  session: z.object({
    token: sessionTokenSchema,
    expires_at: dateTimeSchema,
  }).strict(),
}).strict();

const leaseSchema = z.object({
  id: uuidSchema,
  job_id: uuidSchema,
  generation: generationSchema,
  heartbeat_deadline: dateTimeSchema,
  lease_deadline: dateTimeSchema,
}).strict();

const jobSchema = z.object({
  id: uuidSchema,
  type: z.string(),
  input: z.record(z.string(), z.unknown()),
  data_class: z.enum(["public", "authorized", "intranet"]),
  placement: z.object({
    class: z.enum(["public", "private"]),
    pinned_worker_id: uuidSchema.nullable(),
  }).strict(),
  required_capabilities: z.record(z.string(), z.unknown()),
  budget: z.object({
    deadline_ms: z.number().int().positive().max(86_400_000),
    max_provider_attempts: z.number().int().positive().max(1_000_000),
    max_document_bytes: z.number().int().positive().safe(),
    max_browser_ms: z.number().int().nonnegative().max(86_400_000),
    max_browser_contexts: z.number().int().nonnegative().max(100_000),
  }).strict(),
  policy_version: z.string(),
  upload_private_artifact: z.boolean(),
  priority: z.number().int().safe(),
  not_before: dateTimeSchema,
  deadline_at: dateTimeSchema,
  status: z.enum(["assigned", "running", "completed", "failed"]),
  result_completeness: z.enum(["complete", "partial"]).nullable(),
  error_code: z.string().nullable(),
}).strict();

const claimResponseSchema = z.object({
  request_id: uuidSchema,
  job: jobSchema,
  lease: leaseSchema,
}).strict();

const heartbeatResponseSchema = z.object({
  request_id: uuidSchema,
  lease: leaseSchema,
}).strict();

const completionResponseSchema = z.object({
  request_id: uuidSchema,
  job: jobSchema,
}).strict();

const problemSchema = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
  request_id: uuidSchema,
  retryable: z.boolean(),
  errors: z.array(z.object({
    field: z.string(),
    message: z.string(),
  }).strict()).optional(),
}).strict();

const completedTerminalSchema = z.object({
  status: z.literal("completed"),
  resultCompleteness: z.enum(["complete", "partial"]),
  errorCode: z.null(),
}).strict();
const failedTerminalSchema = z.object({
  status: z.literal("failed"),
  resultCompleteness: z.null(),
  errorCode: z.string().trim().min(1).max(128),
}).strict();
const terminalSchema = z.discriminatedUnion("status", [completedTerminalSchema, failedTerminalSchema]);

export type RemoteWorkerRecord = Readonly<{
  id: string;
  projectId: string;
  name: string;
  kind: "public" | "private";
  version: string;
  capabilityHash: string;
  status: "active" | "disabled";
  createdByUserId: string;
  createdAt: Date;
  disabledAt: Date | null;
}>;

export type RemoteWorkerLease = Readonly<{
  id: string;
  jobId: string;
  generation: number;
  heartbeatDeadline: Date;
  leaseDeadline: Date;
}>;

export type RemoteWorkerJob = ControlPlaneJobRequest & Readonly<{
  id: string;
  dataClass: "public" | "authorized" | "intranet";
  placement: Readonly<{ class: "public" | "private"; pinnedWorkerId: string | null }>;
  requiredCapabilities: ControlPlaneRequiredCapabilities;
  budget: Readonly<{
    deadlineMs: number;
    maxProviderAttempts: number;
    maxDocumentBytes: number;
    maxBrowserMs: number;
    maxBrowserContexts: number;
  }>;
  policyVersion: string;
  uploadPrivateArtifact: boolean;
  priority: number;
  notBefore: Date;
  deadlineAt: Date;
  status: "assigned" | "running" | "completed" | "failed";
  resultCompleteness: "complete" | "partial" | null;
  errorCode: string | null;
}>;

export type RemoteWorkerTerminal =
  | z.infer<typeof completedTerminalSchema>
  | z.infer<typeof failedTerminalSchema>;

export class RemoteWorkerConfigurationError extends Error {
  constructor() {
    super("The Remote Worker control URL is invalid or insecure.");
    this.name = "RemoteWorkerConfigurationError";
  }
}

export class RemoteWorkerInputError extends Error {
  constructor() {
    super("The Remote Worker request input is invalid.");
    this.name = "RemoteWorkerInputError";
  }
}

export class RemoteWorkerTransportError extends Error {
  constructor() {
    super("The Remote Worker control request failed.");
    this.name = "RemoteWorkerTransportError";
  }
}

export class RemoteWorkerProtocolError extends Error {
  constructor() {
    super("The Remote Worker control response violated the protocol.");
    this.name = "RemoteWorkerProtocolError";
  }
}

export class RemoteWorkerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`The Remote Worker control request failed with ${code} (${status}).`);
    this.name = "RemoteWorkerHttpError";
  }
}

type ClientDependencies = Readonly<{ fetch?: typeof fetch }>;

export type RemoteWorkerEnrollmentResult = Readonly<{
  requestId: string;
  worker: RemoteWorkerRecord;
}>;
export type RemoteWorkerSession = Readonly<{
  requestId: string;
  token: string;
  expiresAt: Date;
}>;
export type RemoteWorkerClaim = Readonly<{
  requestId: string;
  job: RemoteWorkerJob;
  lease: RemoteWorkerLease;
}>;
export type RemoteWorkerHeartbeat = Readonly<{
  requestId: string;
  lease: RemoteWorkerLease;
}>;
export type RemoteWorkerCompletion = Readonly<{
  requestId: string;
  job: RemoteWorkerJob;
}>;

function input<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RemoteWorkerInputError();
  return parsed.data;
}

function response<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RemoteWorkerProtocolError();
  return parsed.data;
}

function controlBaseUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteWorkerConfigurationError();
  }
  const loopbackHttp = url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (
    !(url.protocol === "https:" || loopbackHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/v1" && url.pathname !== "/v1/")
  ) {
    throw new RemoteWorkerConfigurationError();
  }
  url.pathname = "/v1/";
  return url;
}

function mediaType(headers: Headers): string {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function jsonBody(result: Response, expectedMediaType: string): Promise<unknown> {
  if (mediaType(result.headers) !== expectedMediaType) throw new RemoteWorkerProtocolError();
  let text: string;
  try {
    text = await result.text();
  } catch {
    throw new RemoteWorkerProtocolError();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RemoteWorkerProtocolError();
  }
}

function worker(value: z.infer<typeof workerSchema>): RemoteWorkerRecord {
  return Object.freeze({
    id: value.id,
    projectId: value.project_id,
    name: value.name,
    kind: value.kind,
    version: value.version,
    capabilityHash: value.capability_hash,
    status: value.status,
    createdByUserId: value.created_by_user_id,
    createdAt: new Date(value.created_at),
    disabledAt: value.disabled_at === null ? null : new Date(value.disabled_at),
  });
}

function lease(value: z.infer<typeof leaseSchema>): RemoteWorkerLease {
  return Object.freeze({
    id: value.id,
    jobId: value.job_id,
    generation: value.generation,
    heartbeatDeadline: new Date(value.heartbeat_deadline),
    leaseDeadline: new Date(value.lease_deadline),
  });
}

function job(value: z.infer<typeof jobSchema>): RemoteWorkerJob {
  let request: ReturnType<typeof parseControlPlaneJobCreation>;
  try {
    request = parseControlPlaneJobCreation(value.type, value.input, value.required_capabilities);
  } catch {
    throw new RemoteWorkerProtocolError();
  }
  return Object.freeze({
    ...request,
    id: value.id,
    dataClass: value.data_class,
    placement: Object.freeze({
      class: value.placement.class,
      pinnedWorkerId: value.placement.pinned_worker_id,
    }),
    requiredCapabilities: Object.freeze(request.requiredCapabilities),
    budget: Object.freeze({
      deadlineMs: value.budget.deadline_ms,
      maxProviderAttempts: value.budget.max_provider_attempts,
      maxDocumentBytes: value.budget.max_document_bytes,
      maxBrowserMs: value.budget.max_browser_ms,
      maxBrowserContexts: value.budget.max_browser_contexts,
    }),
    policyVersion: value.policy_version,
    uploadPrivateArtifact: value.upload_private_artifact,
    priority: value.priority,
    notBefore: new Date(value.not_before),
    deadlineAt: new Date(value.deadline_at),
    status: value.status,
    resultCompleteness: value.result_completeness,
    errorCode: value.error_code,
  }) as RemoteWorkerJob;
}

export class RemoteWorkerClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string | URL, dependencies: ClientDependencies = {}) {
    this.#baseUrl = controlBaseUrl(baseUrl);
    this.#fetch = dependencies.fetch ?? fetch;
  }

  async enroll(options: Readonly<{
    enrollmentToken: string;
    identity: InMemoryWorkerIdentity;
    version: string;
    capabilities: Readonly<Record<string, unknown>>;
    signal?: AbortSignal | undefined;
  }>): Promise<RemoteWorkerEnrollmentResult> {
    const enrollmentToken = input(enrollmentTokenSchema, options.enrollmentToken);
    const version = input(versionSchema, options.version);
    const capabilities = input(capabilityManifestSchema, options.capabilities);
    const result = await this.request("worker-enrollments", "POST", {
      public_key_spki: options.identity.publicKeySpki,
      version,
      capabilities,
    }, enrollmentToken, options.signal, [201]);
    const parsed = response(workerResponseSchema, result.body);
    if (parsed.worker.status !== "active") throw new RemoteWorkerProtocolError();
    return Object.freeze({ requestId: parsed.request_id, worker: worker(parsed.worker) });
  }

  async createSession(options: Readonly<{
    workerId: string;
    identity: InMemoryWorkerIdentity;
    signal?: AbortSignal | undefined;
  }>): Promise<RemoteWorkerSession> {
    const workerId = input(uuidSchema, options.workerId);
    const challenged = await this.request("worker-sessions/challenges", "POST", {
      worker_id: workerId,
    }, null, options.signal, [201]);
    const challengeResult = response(challengeResponseSchema, challenged.body);
    if (
      challengeResult.challenge.worker_id !== workerId ||
      challengeResult.challenge.signing_payload !==
        workerSigningPayload(challengeResult.challenge.challenge)
    ) {
      throw new RemoteWorkerProtocolError();
    }
    let signature: string;
    try {
      signature = options.identity.signSessionChallenge(
        challengeResult.challenge.challenge,
        challengeResult.challenge.signing_payload,
      );
    } catch {
      throw new RemoteWorkerProtocolError();
    }
    const exchanged = await this.request("worker-sessions", "POST", {
      worker_id: workerId,
      challenge: challengeResult.challenge.challenge,
      signature,
    }, null, options.signal, [201]);
    const sessionResult = response(sessionResponseSchema, exchanged.body);
    return Object.freeze({
      requestId: sessionResult.request_id,
      token: sessionResult.session.token,
      expiresAt: new Date(sessionResult.session.expires_at),
    });
  }

  async claim(options: Readonly<{
    workerId: string;
    sessionToken: string;
    waitMs?: number | undefined;
    signal?: AbortSignal | undefined;
  }>): Promise<RemoteWorkerClaim | null> {
    const workerId = input(uuidSchema, options.workerId);
    const token = input(sessionTokenSchema, options.sessionToken);
    const waitMs = input(z.number().int().min(0).max(30_000), options.waitMs ?? 0);
    const result = await this.request(
      `workers/${workerId}/claims`, "POST", { wait_ms: waitMs }, token, options.signal, [200, 204],
    );
    if (result.status === 204) return null;
    const parsed = response(claimResponseSchema, result.body);
    if (parsed.lease.job_id !== parsed.job.id) throw new RemoteWorkerProtocolError();
    return Object.freeze({
      requestId: parsed.request_id,
      job: job(parsed.job),
      lease: lease(parsed.lease),
    });
  }

  async heartbeat(options: Readonly<{
    sessionToken: string;
    leaseId: string;
    generation: number;
    signal?: AbortSignal | undefined;
  }>): Promise<RemoteWorkerHeartbeat> {
    const token = input(sessionTokenSchema, options.sessionToken);
    const leaseId = input(uuidSchema, options.leaseId);
    const generation = input(generationSchema, options.generation);
    const result = await this.request(
      `job-leases/${leaseId}`, "PATCH", { generation }, token, options.signal, [200],
    );
    const parsed = response(heartbeatResponseSchema, result.body);
    if (parsed.lease.id !== leaseId || parsed.lease.generation !== generation) {
      throw new RemoteWorkerProtocolError();
    }
    return Object.freeze({ requestId: parsed.request_id, lease: lease(parsed.lease) });
  }

  async complete(options: Readonly<{
    sessionToken: string;
    leaseId: string;
    generation: number;
    terminal: RemoteWorkerTerminal;
    signal?: AbortSignal | undefined;
  }>): Promise<RemoteWorkerCompletion> {
    const token = input(sessionTokenSchema, options.sessionToken);
    const leaseId = input(uuidSchema, options.leaseId);
    const generation = input(generationSchema, options.generation);
    const terminal = input(terminalSchema, options.terminal);
    const body = {
      generation,
      status: terminal.status,
      result_completeness: terminal.resultCompleteness,
      error_code: terminal.errorCode,
    };
    const result = await this.request(
      `job-leases/${leaseId}/complete`, "POST", body, token, options.signal, [200],
    );
    const parsed = response(completionResponseSchema, result.body);
    if (parsed.job.status !== terminal.status) throw new RemoteWorkerProtocolError();
    return Object.freeze({ requestId: parsed.request_id, job: job(parsed.job) });
  }

  private async request(
    path: string,
    method: "POST" | "PATCH",
    body: unknown,
    token: string | null,
    signal: AbortSignal | undefined,
    expectedStatuses: readonly number[],
  ): Promise<Readonly<{ status: number; body: unknown }>> {
    const headers: Record<string, string> = {
      accept: "application/json, application/problem+json",
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    };
    let result: Response;
    try {
      result = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw new RemoteWorkerTransportError();
    }
    if (expectedStatuses.includes(result.status)) {
      if (result.status === 204) {
        let text: string;
        try {
          text = await result.text();
        } catch {
          throw new RemoteWorkerProtocolError();
        }
        if (text !== "") throw new RemoteWorkerProtocolError();
        return Object.freeze({ status: result.status, body: null });
      }
      return Object.freeze({
        status: result.status,
        body: await jsonBody(result, "application/json"),
      });
    }
    if (result.status >= 400 && result.status <= 599) {
      const parsed = response(
        problemSchema,
        await jsonBody(result, "application/problem+json"),
      );
      if (parsed.status !== result.status) throw new RemoteWorkerProtocolError();
      const retryAfter = result.headers.get("retry-after");
      const retryAfterSeconds = retryAfter === null ? null : Number(retryAfter);
      if (
        result.status === 429 &&
        (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds === null || retryAfterSeconds < 1)
      ) {
        throw new RemoteWorkerProtocolError();
      }
      throw new RemoteWorkerHttpError(
        parsed.status,
        parsed.code,
        parsed.request_id,
        parsed.retryable,
        Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds !== null
          ? retryAfterSeconds
          : null,
      );
    }
    throw new RemoteWorkerProtocolError();
  }
}
