import { z } from "zod";

import {
  parseControlPlaneJobCreation,
  type ControlPlaneJobRequest,
  type ControlPlaneRequiredCapabilities,
} from "../control-plane/job-input.js";
import { workerSigningPayload } from "../control-plane/worker-challenge-budget.js";
import type { InMemoryWorkerIdentity } from "./enrollment.js";

import {
  uuidSchema,
  enrollmentTokenSchema,
  sessionTokenSchema,
  versionSchema,
  generationSchema,
  dateTimeSchema,
  maximumWorkerResponseBytes,
  capabilityManifestSchema,
  workerSchema,
  workerResponseSchema,
  challengeResponseSchema,
  sessionResponseSchema,
  leaseSchema,
  jobSchema,
  claimResponseSchema,
  heartbeatResponseSchema,
  completionResponseSchema,
  contentHashSchema,
  usageSchema,
  eventInputSchema,
  publicationInputSchema,
  eventSchema,
  eventResponseSchema,
  artifactSchema,
  publicationSchema,
  publicationResponseSchema,
  problemSchema,
  completedTerminalSchema,
  failedTerminalSchema,
  terminalSchema,
  artifactUploadResponseSchema,
  artifactConfirmResponseSchema,
} from "./client-schemas.js";

type RemoteWorkerOperation =
  | "enroll"
  | "challenge"
  | "session"
  | "claim"
  | "heartbeat"
  | "event"
  | "publication"
  | "complete"
  | "artifact-upload"
  | "artifact-confirm";

const operationContracts: Readonly<Record<RemoteWorkerOperation, Readonly<{
  success: readonly number[];
  errors: readonly number[];
}>>> = Object.freeze({
  enroll: Object.freeze({ success: [201], errors: [400, 401, 413, 415, 422, 500] }),
  challenge: Object.freeze({ success: [201], errors: [400, 413, 415, 422, 429, 500] }),
  session: Object.freeze({ success: [201], errors: [400, 413, 415, 422, 500] }),
  claim: Object.freeze({ success: [200, 204], errors: [400, 401, 403, 413, 415, 422, 500] }),
  heartbeat: Object.freeze({ success: [200], errors: [400, 401, 409, 413, 415, 422, 500] }),
  event: Object.freeze({ success: [200], errors: [400, 401, 403, 409, 413, 415, 422, 500] }),
  publication: Object.freeze({ success: [200], errors: [400, 401, 403, 409, 413, 415, 422, 500] }),
  complete: Object.freeze({ success: [200], errors: [400, 401, 409, 413, 415, 422, 500] }),
  "artifact-upload": Object.freeze({ success: [201], errors: [400, 401, 409, 413, 415, 422, 500, 503] }),
  "artifact-confirm": Object.freeze({ success: [200], errors: [400, 401, 409, 413, 415, 422, 500, 503] }),
});

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

export class RemoteWorkerArtifactUploadError extends Error {
  constructor(readonly status: number) {
    super(`Object storage rejected the Artifact upload with HTTP ${status}.`);
    this.name = "RemoteWorkerArtifactUploadError";
  }
}

export class RemoteWorkerHttpError extends Error {
  readonly #code: string;

  constructor(
    readonly status: number,
    code: string,
    readonly requestId: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null,
  ) {
    super("The Remote Worker control request was rejected.");
    this.name = "RemoteWorkerHttpError";
    this.#code = code;
  }

  get code(): string {
    return this.#code;
  }
}

export type RemoteWorkerOutcomeUnknownMetadata =
  | Readonly<{ operation: "enroll" }>
  | Readonly<{ operation: "claim"; workerId: string }>
  | Readonly<{
      operation: "complete";
      leaseId: string;
      generation: number;
      expectedJobId: string;
    }>;

export class RemoteWorkerOutcomeUnknownError extends Error {
  readonly metadata: RemoteWorkerOutcomeUnknownMetadata;

  constructor(metadata: RemoteWorkerOutcomeUnknownMetadata) {
    super("The Remote Worker request outcome is unknown.");
    this.name = "RemoteWorkerOutcomeUnknownError";
    this.metadata = Object.freeze({ ...metadata }) as RemoteWorkerOutcomeUnknownMetadata;
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

function preserveCallerAbort(signal: AbortSignal | undefined, error: unknown): never {
  if (signal?.aborted === true) throw signal.reason;
  if (error instanceof RemoteWorkerProtocolError) throw error;
  throw new RemoteWorkerProtocolError();
}

async function decodedBody(result: Response, signal: AbortSignal | undefined): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (result.body === null) return new Uint8Array();
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumWorkerResponseBytes) {
        await reader.cancel("Remote Worker response exceeded the decoded-byte limit.");
        throw new RemoteWorkerProtocolError();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    preserveCallerAbort(signal, error);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function jsonBody(result: Response, bytes: Uint8Array, expectedMediaType: string): unknown {
  if (mediaType(result.headers) !== expectedMediaType) throw new RemoteWorkerProtocolError();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
function canonicalUsage(value: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
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
    return this.possiblyCommitted(
      { operation: "enroll" },
      options.signal,
      async () => {
        const result = await this.request("enroll", "worker-enrollments", "POST", {
          public_key_spki: options.identity.publicKeySpki,
          version,
          capabilities,
        }, enrollmentToken, options.signal);
        const parsed = response(workerResponseSchema, result.body);
        if (parsed.worker.status !== "active") throw new RemoteWorkerProtocolError();
        return Object.freeze({ requestId: parsed.request_id, worker: worker(parsed.worker) });
      },
    );
  }

  async createSession(options: Readonly<{
    workerId: string;
    identity: InMemoryWorkerIdentity;
    signal?: AbortSignal | undefined;
  }>): Promise<RemoteWorkerSession> {
    const workerId = input(uuidSchema, options.workerId);
    const challenged = await this.request("challenge", "worker-sessions/challenges", "POST", {
      worker_id: workerId,
    }, null, options.signal);
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
    const exchanged = await this.request("session", "worker-sessions", "POST", {
      worker_id: workerId,
      challenge: challengeResult.challenge.challenge,
      signature,
    }, null, options.signal);
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
    return this.possiblyCommitted(
      { operation: "claim", workerId },
      options.signal,
      async () => {
        const result = await this.request(
          "claim", `workers/${workerId}/claims`, "POST", { wait_ms: waitMs }, token, options.signal,
        );
        if (result.status === 204) return null;
        const parsed = response(claimResponseSchema, result.body);
        if (parsed.lease.job_id !== parsed.job.id || parsed.job.status !== "running") {
          throw new RemoteWorkerProtocolError();
        }
        return Object.freeze({
          requestId: parsed.request_id,
          job: job(parsed.job),
          lease: lease(parsed.lease),
        });
      },
    );
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
      "heartbeat", `job-leases/${leaseId}`, "PATCH", { generation }, token, options.signal,
    );
    const parsed = response(heartbeatResponseSchema, result.body);
    if (parsed.lease.id !== leaseId || parsed.lease.generation !== generation) {
      throw new RemoteWorkerProtocolError();
    }
    return Object.freeze({ requestId: parsed.request_id, lease: lease(parsed.lease) });
  }

  async appendEvent(options: Readonly<{ sessionToken: string; leaseId: string; expectedJobId: string;
    generation: number; localSequence: number; eventType: string; pageStatus: number | null;
    errorCode: string | null; provider: string | null; byteCount: number; durationMs: number;
    contentHash: string | null; usage: Readonly<Record<string, number>>; occurredAt: Date;
    signal?: AbortSignal | undefined }>) {
    const token = input(sessionTokenSchema, options.sessionToken), leaseId = input(uuidSchema, options.leaseId);
    const expectedJobId = input(uuidSchema, options.expectedJobId), generation = input(generationSchema, options.generation);
    const event = input(eventInputSchema, { localSequence: options.localSequence, eventType: options.eventType, pageStatus: options.pageStatus, errorCode: options.errorCode, provider: options.provider, byteCount: options.byteCount, durationMs: options.durationMs, contentHash: options.contentHash, usage: options.usage, occurredAt: options.occurredAt }), usage = canonicalUsage(event.usage);
    const body = { generation, local_sequence: event.localSequence, event_type: event.eventType,
      page_status: event.pageStatus, error_code: event.errorCode, provider: event.provider,
      byte_count: event.byteCount, duration_ms: event.durationMs, content_hash: event.contentHash,
      usage, occurred_at: event.occurredAt.toISOString() };
    const parsed = response(eventResponseSchema, (await this.request(
      "event", `job-leases/${leaseId}/events`, "POST", body, token, options.signal,
    )).body), value = parsed.event;
    if (value.job_id !== expectedJobId || value.lease_id !== leaseId || value.lease_generation !== generation ||
        value.local_sequence !== event.localSequence || value.event_type !== event.eventType || value.page_status !== event.pageStatus ||
        value.error_code !== event.errorCode || value.provider !== event.provider || value.byte_count !== event.byteCount ||
        value.duration_ms !== event.durationMs || value.content_hash !== event.contentHash || value.occurred_at !== body.occurred_at ||
        JSON.stringify(canonicalUsage(value.usage)) !== JSON.stringify(usage)) throw new RemoteWorkerProtocolError();
    return Object.freeze({ requestId: parsed.request_id, event: Object.freeze({ id: value.id, jobId: value.job_id,
      leaseId: value.lease_id, leaseGeneration: value.lease_generation, localSequence: value.local_sequence,
      sequence: value.sequence, eventType: value.event_type, pageStatus: value.page_status, errorCode: value.error_code,
      provider: value.provider, byteCount: value.byte_count, durationMs: value.duration_ms, contentHash: value.content_hash,
      usage: canonicalUsage(value.usage), occurredAt: new Date(value.occurred_at), recordedAt: new Date(value.recorded_at) }) });
  }

  async publishResult(options: Readonly<{ sessionToken: string; leaseId: string; expectedJobId: string;
    generation: number; localSequence: number; contentHash: string; byteCount: number; mediaType: string;
    completeness: "complete" | "partial"; storage: "worker_local" | "cloud_object";
    signal?: AbortSignal | undefined }>) {
    const token = input(sessionTokenSchema, options.sessionToken), leaseId = input(uuidSchema, options.leaseId);
    const expectedJobId = input(uuidSchema, options.expectedJobId), generation = input(generationSchema, options.generation);
    const publication = input(publicationInputSchema, { localSequence: options.localSequence, contentHash: options.contentHash, byteCount: options.byteCount, mediaType: options.mediaType, completeness: options.completeness, storage: options.storage });
    const body = { generation, local_sequence: publication.localSequence, content_hash: publication.contentHash,
      byte_count: publication.byteCount, media_type: publication.mediaType, completeness: publication.completeness, storage: publication.storage };
    const parsed = response(publicationResponseSchema, (await this.request(
      "publication", `job-leases/${leaseId}/publications`, "POST", body, token, options.signal,
    )).body), value = parsed.publication;
    if (value.job_id !== expectedJobId || value.lease_id !== leaseId || value.lease_generation !== generation ||
        value.local_sequence !== publication.localSequence || value.completeness !== publication.completeness ||
        value.artifact.content_hash !== publication.contentHash || value.artifact.byte_count !== publication.byteCount ||
        value.artifact.media_type !== publication.mediaType || value.artifact.storage !== publication.storage) throw new RemoteWorkerProtocolError();
    const artifact = value.artifact;
    return Object.freeze({ requestId: parsed.request_id, publication: Object.freeze({ id: value.id, jobId: value.job_id,
      leaseId: value.lease_id, leaseGeneration: value.lease_generation, localSequence: value.local_sequence,
      sequence: value.sequence, completeness: value.completeness, recordedAt: new Date(value.recorded_at),
      artifact: Object.freeze({ id: artifact.id, version: artifact.version, contentHash: artifact.content_hash,
        byteCount: artifact.byte_count, mediaType: artifact.media_type, storage: artifact.storage,
        objectKey: artifact.object_key, createdAt: new Date(artifact.created_at) }) }) });
  }

  /** Uploads a published cloud Artifact through a presigned PUT, then asks the control plane to verify it. */
  async uploadArtifact(options: Readonly<{
    sessionToken: string;
    leaseId: string;
    generation: number;
    artifactId: string;
    bytes: Uint8Array;
    signal?: AbortSignal | undefined;
  }>): Promise<Readonly<{ uploadedAt: Date }>> {
    const token = input(sessionTokenSchema, options.sessionToken), leaseId = input(uuidSchema, options.leaseId);
    const body = { generation: input(generationSchema, options.generation), artifact_id: input(uuidSchema, options.artifactId) };
    const upload = response(artifactUploadResponseSchema, (await this.request(
      "artifact-upload", `job-leases/${leaseId}/artifact-uploads`, "POST", body, token, options.signal,
    )).body).upload;
    let stored: Response;
    try {
      stored = await this.#fetch(upload.url, {
        method: "PUT", headers: upload.headers, body: new Uint8Array(options.bytes), redirect: "error",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await stored.body?.cancel();
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason;
      throw new RemoteWorkerTransportError();
    }
    if (stored.status < 200 || stored.status > 299) throw new RemoteWorkerArtifactUploadError(stored.status);
    const confirmed = response(artifactConfirmResponseSchema, (await this.request(
      "artifact-confirm", `job-leases/${leaseId}/artifact-uploads/confirm`, "POST", body, token, options.signal,
    )).body);
    return Object.freeze({ uploadedAt: new Date(confirmed.uploaded_at) });
  }

  async complete(options: Readonly<{
    sessionToken: string;
    leaseId: string;
    expectedJobId: string;
    generation: number;
    terminal: RemoteWorkerTerminal;
    signal?: AbortSignal | undefined;
  }>): Promise<RemoteWorkerCompletion> {
    const token = input(sessionTokenSchema, options.sessionToken);
    const leaseId = input(uuidSchema, options.leaseId);
    const expectedJobId = input(uuidSchema, options.expectedJobId);
    const generation = input(generationSchema, options.generation);
    const terminal = input(terminalSchema, options.terminal);
    const body = {
      generation,
      status: terminal.status,
      result_completeness: terminal.resultCompleteness,
      error_code: terminal.errorCode,
    };
    return this.possiblyCommitted(
      { operation: "complete", leaseId, generation, expectedJobId },
      options.signal,
      async () => {
        const result = await this.request(
          "complete", `job-leases/${leaseId}/complete`, "POST", body, token, options.signal,
        );
        const parsed = response(completionResponseSchema, result.body);
        const completed = job(parsed.job);
        if (
          completed.id !== expectedJobId ||
          completed.status !== terminal.status ||
          completed.resultCompleteness !== terminal.resultCompleteness ||
          completed.errorCode !== terminal.errorCode
        ) {
          throw new RemoteWorkerProtocolError();
        }
        return Object.freeze({ requestId: parsed.request_id, job: completed });
      },
    );
  }

  private async request(
    operation: RemoteWorkerOperation,
    path: string,
    method: "POST" | "PATCH",
    body: unknown,
    token: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Readonly<{ status: number; body: unknown }>> {
    signal?.throwIfAborted();
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
      if (signal?.aborted === true) throw signal.reason;
      throw new RemoteWorkerTransportError();
    }
    try {
      const bytes = await decodedBody(result, signal);
      const contract = operationContracts[operation];
      if (contract.success.includes(result.status)) {
        if (result.status === 204) {
          if (bytes.byteLength !== 0) throw new RemoteWorkerProtocolError();
          return Object.freeze({ status: result.status, body: null });
        }
        return Object.freeze({
          status: result.status,
          body: jsonBody(result, bytes, "application/json"),
        });
      }
      if (contract.errors.includes(result.status)) {
        const parsed = response(
          problemSchema,
          jsonBody(result, bytes, "application/problem+json"),
        );
        if (parsed.status !== result.status) throw new RemoteWorkerProtocolError();
        const retryAfter = result.headers.get("retry-after");
        const validRetryAfter = retryAfter !== null && /^[1-9][0-9]*$/u.test(retryAfter);
        const retryAfterSeconds = validRetryAfter ? Number(retryAfter) : null;
        if (
          result.status === 429 &&
          (operation !== "challenge" || !Number.isSafeInteger(retryAfterSeconds))
        ) {
          throw new RemoteWorkerProtocolError();
        }
        if (result.status !== 429 && retryAfter !== null) throw new RemoteWorkerProtocolError();
        throw new RemoteWorkerHttpError(
          parsed.status,
          parsed.code,
          parsed.request_id,
          parsed.retryable,
          retryAfterSeconds,
        );
      }
      throw new RemoteWorkerProtocolError();
    } catch (error) {
      if (signal?.aborted === true && Object.is(error, signal.reason)) throw error;
      if (error instanceof RemoteWorkerHttpError || error instanceof RemoteWorkerProtocolError) {
        throw error;
      }
      throw new RemoteWorkerProtocolError();
    }
  }

  private async possiblyCommitted<Result>(
    metadata: RemoteWorkerOutcomeUnknownMetadata,
    signal: AbortSignal | undefined,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted === true && Object.is(error, signal.reason)) {
        throw new RemoteWorkerOutcomeUnknownError(metadata);
      }
      if (error instanceof RemoteWorkerHttpError || error instanceof RemoteWorkerOutcomeUnknownError) {
        throw error;
      }
      if (error instanceof RemoteWorkerProtocolError || error instanceof RemoteWorkerTransportError) {
        throw new RemoteWorkerOutcomeUnknownError(metadata);
      }
      throw error;
    }
  }
}
