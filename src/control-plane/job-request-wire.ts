import { z } from "zod";

import { controlPlaneJobTypes } from "./job-input.js";
import type { CreateControlPlaneJobInput } from "./project-scope.js";

// The public Job creation body, shared by direct Job creation and stored schedule templates.

export class ProjectJobInputError extends Error {
  readonly code = "JOB_REQUEST_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ProjectJobInputError";
  }
}

const jsonObjectSchema = z.record(z.string(), z.unknown());
const safePositiveInteger = z.number().int().positive().safe();
const safeNonnegativeInteger = z.number().int().nonnegative().safe();
export const createJobBodySchema = z.object({
  type: z.enum(controlPlaneJobTypes),
  input: jsonObjectSchema,
  data_class: z.enum(["public", "authorized", "intranet"]),
  placement: z.object({
    class: z.enum(["public", "private"]),
    pinned_worker_id: z.uuid().nullable(),
  }).strict(),
  required_capabilities: jsonObjectSchema,
  budget: z.object({
    deadline_ms: safePositiveInteger.max(86_400_000),
    max_provider_attempts: safePositiveInteger.max(1_000_000),
    max_document_bytes: safePositiveInteger.max(Number.MAX_SAFE_INTEGER),
    max_browser_ms: safeNonnegativeInteger.max(86_400_000),
    max_browser_contexts: safeNonnegativeInteger.max(100_000),
  }).strict(),
  policy_version: z.string().trim().min(1).max(256),
  upload_private_artifact: z.boolean(),
  priority: z.number().int().min(-100).max(100).optional(),
  not_before: z.string().datetime({ offset: true }).optional(),
  dataset: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u).optional(),
}).strict();

export type CreateJobBody = z.infer<typeof createJobBodySchema>;

/** Rejects what no released Worker runs, which would otherwise fail after a claim or wait out its deadline. */
export function assertExecutableJob(job: CreateJobBody): void {
  if (job.type !== "read") {
    throw new ProjectJobInputError(`No released Worker can execute ${job.type} Jobs.`);
  }
  if (job.data_class !== "public" || job.placement.class !== "public") {
    throw new ProjectJobInputError("No released Worker can execute non-public Jobs.");
  }
}

export function jobCreationInput(parsed: CreateJobBody): CreateControlPlaneJobInput {
  // The service validates this dynamic envelope before hashing or persistence.
  return {
    type: parsed.type,
    input: parsed.input,
    dataClass: parsed.data_class,
    placement: {
      class: parsed.placement.class,
      pinnedWorkerId: parsed.placement.pinned_worker_id,
    },
    requiredCapabilities: parsed.required_capabilities,
    budget: {
      deadlineMs: parsed.budget.deadline_ms,
      maxProviderAttempts: parsed.budget.max_provider_attempts,
      maxDocumentBytes: parsed.budget.max_document_bytes,
      maxBrowserMs: parsed.budget.max_browser_ms,
      maxBrowserContexts: parsed.budget.max_browser_contexts,
    },
    policyVersion: parsed.policy_version,
    uploadPrivateArtifact: parsed.upload_private_artifact,
    ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
    ...(parsed.not_before === undefined ? {} : { notBefore: new Date(parsed.not_before) }),
    ...(parsed.dataset === undefined ? {} : { dataset: parsed.dataset }),
  } as CreateControlPlaneJobInput;
}
