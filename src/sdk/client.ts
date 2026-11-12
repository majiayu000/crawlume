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
  /** Project dataset that receives one result item when the Job completes. */
  dataset?: string;
};

type JobResponse<Request> = Request extends CreateJobRequest
  ? Omit<Request, "priority" | "not_before" | "dataset"> & {
  id: string;
  priority: number;
  not_before: string;
  deadline_at: string;
  status: JobStatus;
  result_completeness: "complete" | "partial" | null;
  error_code: string | null;
  dataset_id: string | null;
} : never;

export type Job = JobResponse<CreateJobRequest>;

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

export type CursorPagination = { next_cursor: string | null; has_more: boolean; limit: number };

export type Dataset = {
  id: string;
  name: string;
  item_count: number;
  created_at: string;
  updated_at: string;
};

export type DatasetItemPage = {
  items: Array<Record<string, unknown>>;
  pagination: { offset: number; limit: number; total: number; next_offset: number; has_more: boolean };
};

export type DatasetExportFormat = "json" | "jsonl" | "csv";

export type KeyValueStore = { id: string; name: string; created_at: string };

export type KeyValueRecordMetadata = {
  key: string;
  content_type: string;
  byte_count: number;
  updated_at: string;
};

export type KeyValueRecord = { contentType: string; value: Uint8Array };

export type JobSchedule = {
  id: string;
  name: string;
  cron: string;
  timezone: "UTC";
  job: CreateJobRequest;
  enabled: boolean;
  next_fire_at: string;
  last_fired_at: string | null;
  last_job_id: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateJobScheduleRequest = {
  name: string;
  /** Five-field cron expression evaluated in UTC. */
  cron: string;
  job: CreateJobRequest;
  enabled?: boolean;
};

type RequestOptions = {
  body?: unknown;
  rawBody?: { bytes: Uint8Array<ArrayBuffer> | string; contentType: string };
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** False for writes that would duplicate data when replayed, such as dataset appends. */
  retry?: boolean;
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

function query(options: Readonly<Record<string, string | number | undefined>>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  return parameters.size === 0 ? "" : `?${parameters}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    signal?.throwIfAborted();
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
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
    const controller = new AbortController();
    let lastStatus = "unknown";
    const timeoutError = (): Error => new Error(`Job ${jobId} was still ${lastStatus} after ${timeoutMs}ms.`);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          for (;;) {
            controller.signal.throwIfAborted();
            if (Date.now() >= deadline) throw timeoutError();
            const { job } = await this.request<{ job: Job }>("GET", this.jobPath(jobId), { signal: controller.signal });
            controller.signal.throwIfAborted();
            lastStatus = job.status;
            if (Date.now() >= deadline) throw timeoutError();
            if (terminalStatuses.has(job.status)) return job;
            await delay(Math.min(intervalMs, deadline - Date.now()), controller.signal);
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = timeoutError();
            controller.abort(error);
            reject(error);
          }, Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async listDatasets(options: { cursor?: string; limit?: number } = {}): Promise<{
    datasets: Dataset[];
    pagination: CursorPagination;
  }> {
    return this.request("GET", `${this.projectPath}/datasets${query(options)}`);
  }

  async getDataset(name: string): Promise<Dataset> {
    return (await this.request<{ dataset: Dataset }>("GET", this.datasetPath(name))).dataset;
  }

  /** Appends items in order, creating the dataset on first use. Not retried, to avoid duplicates. */
  async appendDatasetItems(
    name: string,
    items: Array<Record<string, unknown>>,
  ): Promise<{ dataset: Dataset; appended: number }> {
    const body = await this.request<{ dataset: Dataset; appended: number }>(
      "POST", `${this.datasetPath(name)}/items`, { body: { items }, retry: false },
    );
    return { dataset: body.dataset, appended: body.appended };
  }

  async listDatasetItems(name: string, options: { offset?: number; limit?: number } = {}): Promise<DatasetItemPage> {
    const body = await this.request<DatasetItemPage>("GET", `${this.datasetPath(name)}/items${query(options)}`);
    return { items: body.items, pagination: body.pagination };
  }

  /** Yields every dataset item in append order. */
  async *datasetItems(name: string, options: { limit?: number } = {}): AsyncGenerator<Record<string, unknown>> {
    let offset = 0;
    for (;;) {
      const page = await this.listDatasetItems(name, { ...options, offset });
      yield* page.items;
      if (!page.pagination.has_more || page.items.length === 0) return;
      offset = page.pagination.next_offset;
    }
  }

  /** Returns up to 10000 items encoded as JSON, JSON Lines or CSV. */
  async exportDataset(
    name: string,
    options: { format?: DatasetExportFormat; offset?: number; limit?: number } = {},
  ): Promise<string> {
    const response = await this.send("GET", `${this.datasetPath(name)}/export${query(options)}`);
    return response.text();
  }

  async listKeyValueStores(options: { cursor?: string; limit?: number } = {}): Promise<{
    key_value_stores: KeyValueStore[];
    pagination: CursorPagination;
  }> {
    return this.request("GET", `${this.projectPath}/key-value-stores${query(options)}`);
  }

  async listKeyValueRecords(store: string, options: { cursor?: string; limit?: number } = {}): Promise<{
    records: KeyValueRecordMetadata[];
    pagination: CursorPagination;
  }> {
    return this.request("GET", `${this.storePath(store)}/records${query(options)}`);
  }

  async getKeyValueRecord(store: string, key: string): Promise<KeyValueRecord> {
    const response = await this.send("GET", this.recordPath(store, key));
    return {
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      value: new Uint8Array(await response.arrayBuffer()),
    };
  }

  /** Stores bytes or text under the key, creating the store on first use. */
  async putKeyValueRecord(
    store: string,
    key: string,
    value: Uint8Array<ArrayBuffer> | string,
    contentType = typeof value === "string" ? "text/plain; charset=utf-8" : "application/octet-stream",
  ): Promise<KeyValueRecordMetadata> {
    const body = await this.request<{ record: KeyValueRecordMetadata }>(
      "PUT", this.recordPath(store, key), { rawBody: { bytes: value, contentType } },
    );
    return body.record;
  }

  async deleteKeyValueRecord(store: string, key: string): Promise<void> {
    await this.request("DELETE", this.recordPath(store, key), { retry: false });
  }

  async createSchedule(request: CreateJobScheduleRequest): Promise<JobSchedule> {
    return (await this.request<{ schedule: JobSchedule }>(
      "POST", `${this.projectPath}/schedules`, { body: request, retry: false },
    )).schedule;
  }

  async listSchedules(): Promise<JobSchedule[]> {
    return (await this.request<{ schedules: JobSchedule[] }>("GET", `${this.projectPath}/schedules`)).schedules;
  }

  async getSchedule(scheduleId: string): Promise<JobSchedule> {
    return (await this.request<{ schedule: JobSchedule }>("GET", this.schedulePath(scheduleId))).schedule;
  }

  async enableSchedule(scheduleId: string): Promise<JobSchedule> {
    return (await this.request<{ schedule: JobSchedule }>(
      "POST", `${this.schedulePath(scheduleId)}/enable`, { body: {} },
    )).schedule;
  }

  async disableSchedule(scheduleId: string): Promise<JobSchedule> {
    return (await this.request<{ schedule: JobSchedule }>(
      "POST", `${this.schedulePath(scheduleId)}/disable`, { body: {} },
    )).schedule;
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.request("DELETE", this.schedulePath(scheduleId), { retry: false });
  }

  private jobPath(jobId: string): string {
    return `${this.projectPath}/jobs/${encodeURIComponent(jobId)}`;
  }

  private datasetPath(name: string): string {
    return `${this.projectPath}/datasets/${encodeURIComponent(name)}`;
  }

  private storePath(store: string): string {
    return `${this.projectPath}/key-value-stores/${encodeURIComponent(store)}`;
  }

  private recordPath(store: string, key: string): string {
    return `${this.storePath(store)}/records/${encodeURIComponent(key)}`;
  }

  private schedulePath(scheduleId: string): string {
    return `${this.projectPath}/schedules/${encodeURIComponent(scheduleId)}`;
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, options);
    if (response.status === 204) return undefined as T;
    const result = await response.json() as T;
    options.signal?.throwIfAborted();
    return result;
  }

  /** Sends the request, retrying retryable failures, and returns the successful response. */
  private async send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.rawBody !== undefined) headers["content-type"] = options.rawBody.contentType;
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    const body = options.rawBody !== undefined ? options.rawBody.bytes
      : options.body === undefined ? undefined : JSON.stringify(options.body);
    for (let attempt = 0; ; attempt += 1) {
      options.signal?.throwIfAborted();
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(body === undefined ? {} : { body }),
      });
      options.signal?.throwIfAborted();
      if (response.ok) return response;
      const text = await response.text();
      options.signal?.throwIfAborted();
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
      // Requests are idempotent (GETs, Idempotency-Key creates, controls, record PUTs) unless retry is false.
      if (!error.retryable || options.retry === false || attempt >= this.maxRetries) throw error;
      const backoff = Math.min(maxRetryDelayMs, this.retryBaseMs * 2 ** attempt);
      const requiredDelay = Math.max(backoff, parseRetryAfterMs(response.headers.get("retry-after")) ?? 0);
      if (requiredDelay > maxRetryDelayMs) throw error;
      await delay(requiredDelay, options.signal);
    }
  }
}
