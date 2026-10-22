import { randomUUID } from "node:crypto";

import type {
  ControlPlaneJobRequest,
  ControlPlaneRequiredCapabilities,
} from "../control-plane/job-input.js";

export type JobStatus =
  | "accepted" | "queued" | "assigned" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type JobBudget = {
  deadline_ms: number;
  max_provider_attempts: number;
  max_document_bytes: number;
  max_browser_ms: number;
  max_browser_contexts: number;
};

export type CreateJobRequest = ControlPlaneJobRequest & {
  data_class: "public" | "authorized" | "intranet";
  placement: { class: "public" | "private"; pinned_worker_id: string | null };
  required_capabilities: ControlPlaneRequiredCapabilities;
  budget: JobBudget;
  policy_version: string;
  upload_private_artifact: boolean;
  priority?: number;
  not_before?: string;
};

export type Job = Omit<CreateJobRequest, "priority" | "not_before"> & {
  id: string;
  priority: number;
  not_before: string;
  deadline_at: string;
  status: JobStatus;
  result_completeness: "complete" | "partial" | null;
  error_code: string | null;
};

export type Publication = {
  id: string;
  job_id: string;
  lease_id: string;
  lease_generation: number;
  local_sequence: number;
  sequence: number;
  completeness: "complete" | "partial";
  recorded_at: string;
  artifact: {
    id: string;
    version: number;
    content_hash: string;
    byte_count: number;
    media_type: string;
    storage: "worker_local" | "cloud_object";
    object_key: string | null;
    created_at: string;
  };
};

export type PublicationPage = {
  publications: Publication[];
  pagination: { next_sequence: number | null; has_more: boolean; limit: number };
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  request_id: string;
  retryable: boolean;
  errors?: Array<{ field: string; message: string }>;
};

/** RFC 7807 problem returned by the control plane. */
export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly problem: ProblemDetails | null;

  constructor(status: number, problem: ProblemDetails | null, fallback: string) {
    super(problem?.detail ?? fallback);
    this.name = "ControlPlaneError";
    this.status = status;
    this.code = problem?.code ?? "HTTP_ERROR";
    this.retryable = problem?.retryable ?? false;
    this.requestId = problem?.request_id ?? null;
    this.problem = problem;
  }
}

export type CrawlumeClientOptions = {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  fetch?: typeof fetch;
  /** Retries for retryable failures of idempotent requests; never unbounded. */
  maxRetries?: number;
  retryBaseMs?: number;
};

const terminalStatuses: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);
const maxRetryDelayMs = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Parses a Retry-After header (delta-seconds or HTTP date) into milliseconds from nowMs. */
export function parseRetryAfterMs(header: string | null, nowMs = Date.now()): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

export class CrawlumeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly projectPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(options: CrawlumeClientOptions) {
    if (options.apiKey.length === 0) throw new TypeError("apiKey must be non-empty.");
    if (options.projectId.length === 0) throw new TypeError("projectId must be non-empty.");
    const maxRetries = options.maxRetries ?? 3;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      throw new RangeError("maxRetries must be an integer between 0 and 10.");
    }
    this.baseUrl = new URL(options.baseUrl).href.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.projectPath = `/projects/${encodeURIComponent(options.projectId)}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = maxRetries;
    this.retryBaseMs = options.retryBaseMs ?? 250;
  }

  async createJob(request: CreateJobRequest, options: { idempotencyKey?: string } = {}): Promise<Job> {
    const body = await this.request<{ job: Job }>("POST", `${this.projectPath}/jobs`, {
      body: request,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
    return body.job;
  }

  async getJob(jobId: string): Promise<Job> {
    return (await this.request<{ job: Job }>("GET", this.jobPath(jobId))).job;
  }

  async pauseJob(jobId: string): Promise<Job> {
    return (await this.request<{ job: Job }>("POST", `${this.jobPath(jobId)}/pause`, { body: {} })).job;
  }

  async resumeJob(jobId: string): Promise<Job> {
    return (await this.request<{ job: Job }>("POST", `${this.jobPath(jobId)}/resume`, { body: {} })).job;
  }

  async cancelJob(jobId: string): Promise<Job> {
    return (await this.request<{ job: Job }>("POST", `${this.jobPath(jobId)}/cancel`, { body: {} })).job;
  }

  async listPublications(
    jobId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<PublicationPage> {
    const query = new URLSearchParams();
    if (options.afterSequence !== undefined) query.set("after_sequence", String(options.afterSequence));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size === 0 ? "" : `?${query}`;
    const body = await this.request<PublicationPage>("GET", `${this.jobPath(jobId)}/publications${suffix}`);
    return { publications: body.publications, pagination: body.pagination };
  }

  /** Yields every publication in sequence order, following the server cursor. */
  async *publications(jobId: string, options: { limit?: number } = {}): AsyncGenerator<Publication> {
    let afterSequence: number | undefined;
    for (;;) {
      const page = await this.listPublications(jobId, {
        ...(afterSequence === undefined ? {} : { afterSequence }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      yield* page.publications;
      if (!page.pagination.has_more || page.pagination.next_sequence === null) return;
      afterSequence = page.pagination.next_sequence;
    }
  }

  /** Polls until the Job is terminal; throws when timeoutMs elapses first. */
  async waitForJob(jobId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Job> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.getJob(jobId);
      if (terminalStatuses.has(job.status)) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Job ${jobId} was still ${job.status} after ${timeoutMs}ms.`);
      }
      await delay(Math.min(intervalMs, remaining));
    }
  }

  private jobPath(jobId: string): string {
    return `${this.projectPath}/jobs/${encodeURIComponent(jobId)}`;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      if (response.ok) return await response.json() as T;
      const text = await response.text();
      let problem: ProblemDetails | null = null;
      try {
        problem = JSON.parse(text) as ProblemDetails;
      } catch {
        problem = null;
      }
      const error = new ControlPlaneError(
        response.status,
        problem,
        `Control plane returned HTTP ${response.status}.`,
      );
      // Every SDK request is idempotent: GETs, Idempotency-Key creates, and pause/resume/cancel.
      if (!error.retryable || attempt >= this.maxRetries) throw error;
      const backoff = Math.min(maxRetryDelayMs, this.retryBaseMs * 2 ** attempt);
      await delay(Math.min(maxRetryDelayMs, parseRetryAfterMs(response.headers.get("retry-after")) ?? backoff));
    }
  }
}
