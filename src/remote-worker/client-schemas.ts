import { z } from "zod";

// Wire schemas for the Worker control API, shared by RemoteWorkerClient.

export const uuidSchema = z.uuid();
export const enrollmentTokenSchema = z.string().regex(/^dya_we_[A-Za-z0-9_-]{43}$/u);
export const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export const versionSchema = z.string().trim().min(1).max(128);
export const generationSchema = z.number().int().positive().safe();
export const dateTimeSchema = z.string().datetime({ offset: true });
// A claimed Job echoes a <=64 KiB accepted request plus its bounded control-plane projection.
export const maximumWorkerResponseBytes = 256 * 1_024;
export const capabilityManifestSchema = z.record(z.string(), z.unknown()).refine((value) => {
  try {
    const json = JSON.stringify(value);
    return json !== undefined && Buffer.byteLength(json) <= 16 * 1_024;
  } catch {
    return false;
  }
});
export const workerSchema = z.object({
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
export const workerResponseSchema = z.object({
  request_id: uuidSchema,
  worker: workerSchema,
}).strict();
export const challengeResponseSchema = z.object({
  request_id: uuidSchema,
  challenge: z.object({
    worker_id: uuidSchema,
    challenge: z.string().regex(/^dya_wc_[A-Za-z0-9_-]{43}$/u),
    signing_payload: z.string(),
    expires_at: dateTimeSchema,
  }).strict(),
}).strict();
export const sessionResponseSchema = z.object({
  request_id: uuidSchema,
  session: z.object({
    token: sessionTokenSchema,
    expires_at: dateTimeSchema,
  }).strict(),
}).strict();
export const leaseSchema = z.object({
  id: uuidSchema,
  job_id: uuidSchema,
  generation: generationSchema,
  heartbeat_deadline: dateTimeSchema,
  lease_deadline: dateTimeSchema,
}).strict();
export const jobSchema = z.object({
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
export const claimResponseSchema = z.object({
  request_id: uuidSchema,
  job: jobSchema,
  lease: leaseSchema,
}).strict();
export const heartbeatResponseSchema = z.object({
  request_id: uuidSchema,
  lease: leaseSchema,
}).strict();
export const completionResponseSchema = z.object({
  request_id: uuidSchema,
  job: jobSchema,
}).strict();
export const contentHashSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).refine((value) => Buffer.from(value, "base64url").toString("base64url") === value);
export const usageSchema = z.record(z.string(), z.number().finite().nonnegative()).refine((value) => {
  const entries = Object.entries(value);
  return entries.length <= 32 && entries.every(([key]) => key.trim().length > 0 && key.length <= 64);
});
export const eventInputSchema = z.object({
  localSequence: z.number().int().positive().safe(), eventType: z.string().trim().min(1).max(64),
  pageStatus: z.number().int().min(100).max(599).nullable(), errorCode: z.string().trim().min(1).max(128).nullable(),
  provider: z.string().trim().min(1).max(128).nullable(),
  byteCount: z.number().int().nonnegative().safe(), durationMs: z.number().int().nonnegative().safe(),
  contentHash: contentHashSchema.nullable(), usage: usageSchema, occurredAt: z.date(),
}).strict();
export const publicationInputSchema = z.object({
  localSequence: z.number().int().positive().safe(), contentHash: contentHashSchema,
  byteCount: z.number().int().nonnegative().safe(), mediaType: z.string().trim().min(1).max(255),
  completeness: z.enum(["complete", "partial"]), storage: z.enum(["worker_local", "cloud_object"]),
}).strict();
export const eventSchema = z.object({
  id: uuidSchema, job_id: uuidSchema, lease_id: uuidSchema, lease_generation: generationSchema,
  local_sequence: z.number().int().positive().safe(), sequence: z.number().int().positive().safe(),
  event_type: z.string().min(1).max(64), page_status: z.number().int().min(100).max(599).nullable(), error_code: z.string().min(1).max(128).nullable(),
  provider: z.string().min(1).max(128).nullable(),
  byte_count: z.number().int().nonnegative().safe(), duration_ms: z.number().int().nonnegative().safe(),
  content_hash: contentHashSchema.nullable(), usage: usageSchema,
  occurred_at: dateTimeSchema, recorded_at: dateTimeSchema,
}).strict();
export const eventResponseSchema = z.object({ request_id: uuidSchema, event: eventSchema }).strict();
export const artifactSchema = z.object({
  id: uuidSchema, version: z.number().int().positive().safe(), content_hash: contentHashSchema,
  byte_count: z.number().int().nonnegative().safe(), media_type: z.string().min(1).max(255),
  storage: z.enum(["worker_local", "cloud_object"]), object_key: z.string().nullable(), created_at: dateTimeSchema,
}).strict();
export const publicationSchema = z.object({
  id: uuidSchema, job_id: uuidSchema, lease_id: uuidSchema, lease_generation: generationSchema,
  local_sequence: z.number().int().positive().safe(), sequence: z.number().int().positive().safe(),
  completeness: z.enum(["complete", "partial"]), recorded_at: dateTimeSchema, artifact: artifactSchema,
}).strict();
export const publicationResponseSchema = z.object({ request_id: uuidSchema, publication: publicationSchema }).strict();

export const artifactUploadResponseSchema = z.object({
  request_id: uuidSchema,
  upload: z.object({
    url: z.string().url().refine((value) => new URL(value).protocol === "https:" || new URL(value).hostname === "127.0.0.1"),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    expires_at: dateTimeSchema,
  }).strict(),
}).strict();
export const artifactConfirmResponseSchema = z.object({ request_id: uuidSchema, uploaded_at: dateTimeSchema }).strict();

export const problemSchema = z.object({
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

export const completedTerminalSchema = z.object({
  status: z.literal("completed"),
  resultCompleteness: z.enum(["complete", "partial"]),
  errorCode: z.null(),
}).strict();
export const failedTerminalSchema = z.object({
  status: z.literal("failed"),
  resultCompleteness: z.null(),
  errorCode: z.string().trim().min(1).max(128),
}).strict();
export const terminalSchema = z.discriminatedUnion("status", [completedTerminalSchema, failedTerminalSchema]);
