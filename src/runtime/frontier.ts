export const frontierPageStates = ["queued", "leased", "succeeded", "failed", "stopped"] as const;
export type FrontierPageState = (typeof frontierPageStates)[number];

export const frontierJobStatuses = [
  "queued", "running", "paused", "completed", "failed", "cancelled",
] as const;
export type FrontierJobStatus = (typeof frontierJobStatuses)[number];

export type FrontierProgress = {
  discovered: number;
  queued: number;
  leased: number;
  succeeded: number;
  failed: number;
  stopped: number;
  published: number;
};

export type FrontierJob = {
  id: string;
  status: FrontierJobStatus;
  input: unknown;
  maxPages: number;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  progress: FrontierProgress;
  pauseRequested: boolean;
  cancelRequested: boolean;
  truncated: boolean;
  concurrency: number;
  budget: import("../types.js").CrawlBudget;
  deadlineAtMs: number;
  usage: import("../types.js").CrawlResourceUsage;
  reservedUsage: import("../types.js").CrawlResourceUsage;
  error: unknown | null;
};

export type FrontierPage = {
  id: string;
  crawlId: string;
  requestedUrl: string;
  normalizedUrl: string;
  origin: string;
  depth: number;
  discoveredFrom: string | null;
  discoverySequence: number;
  state: FrontierPageState;
  nextEligibleAtMs: number;
  executionCount: number;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

export type EnqueueCandidate = {
  requestedUrl: string;
  normalizedUrl: string;
  origin: string;
  depth: number;
  discoveredFrom?: string | null;
  nextEligibleAtMs?: number;
};

export type FrontierLease = {
  page: FrontierPage;
  owner: string;
  generation: number;
  expiresAtMs: number;
  budgetSlice: import("../types.js").ExecutionBudget;
  reservation: import("../types.js").CrawlResourceUsage;
};

export type EnqueueResult = {
  inserted: boolean;
  reason: "enqueued" | "duplicate" | "cap-reached";
  page: FrontierPage | null;
};

export type FrontierPublication = {
  sequence: number;
  page: FrontierPage;
  result: unknown | null;
  error: unknown | null;
};

export type FrontierPublicationBatch = {
  crawlId: string;
  pages: FrontierPublication[];
  nextSequence: number;
  done: boolean;
};

const jobTransitions: Readonly<Record<FrontierJobStatus, readonly FrontierJobStatus[]>> = {
  queued: ["running", "paused", "cancelled"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionFrontierJob(
  from: FrontierJobStatus,
  to: FrontierJobStatus,
): boolean {
  return from === to || jobTransitions[from].includes(to);
}

type ActivePage = {
  lease: FrontierLease;
  controller: AbortController;
  heartbeat: NodeJS.Timeout;
  promise: Promise<void>;
};

const terminalStatuses = new Set<FrontierJobStatus>(["completed", "failed", "cancelled"]);

function normalizedInput(config: AppConfig, value: DurableCrawlOptions): DurableCrawlOptions {
  const browserAllowed = value.browserAllowed ?? true;
  const maxPages = value.maxPages ?? 10;
  const concurrency = value.concurrency ?? 4;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new ReadError("INVALID_ARGUMENT", "maxPages must be between 1 and 10000.");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new ReadError("INVALID_ARGUMENT", "concurrency must be between 1 and 32.");
  }
  const requestedBudget: ExecutionBudget = value.budget ?? {
    deadlineMs: config.requestTimeoutMs + (browserAllowed ? config.browserTimeoutMs : 0),
    maxAttempts: config.crawlMaxAttempts,
    maxDocumentBytes: config.maxResponseBytes * config.crawlMaxAttempts,
    maxBrowserMs: browserAllowed ? config.browserTimeoutMs : 0,
    maxBrowserContexts: browserAllowed ? 1 : 0,
    maxOptionalModelTokens: 0,
  };
  const crawlBudget = value.crawlBudget ?? {
    maxDurationMs: Math.max(60_000, requestedBudget.deadlineMs * maxPages),
    maxProviderAttempts: requestedBudget.maxAttempts * maxPages,
    maxDocumentBytes: requestedBudget.maxDocumentBytes * maxPages,
    maxBrowserMs: requestedBudget.maxBrowserMs * maxPages,
    maxBrowserContexts: requestedBudget.maxBrowserContexts * maxPages,
  };
  const fairShare = (total: number): number => total === 0 ? 0 : Math.max(1, Math.floor(total / concurrency));
  const budget: ExecutionBudget = {
    deadlineMs: Math.min(requestedBudget.deadlineMs, crawlBudget.maxDurationMs),
    maxAttempts: Math.min(requestedBudget.maxAttempts, crawlBudget.maxProviderAttempts),
    maxDocumentBytes: Math.min(requestedBudget.maxDocumentBytes, fairShare(crawlBudget.maxDocumentBytes)),
    maxBrowserMs: Math.min(requestedBudget.maxBrowserMs, fairShare(crawlBudget.maxBrowserMs)),
    maxBrowserContexts: Math.min(
      requestedBudget.maxBrowserContexts,
      fairShare(crawlBudget.maxBrowserContexts),
    ),
    maxOptionalModelTokens: requestedBudget.maxOptionalModelTokens,
  };
  return {
    ...value,
    browserAllowed,
    cacheMode: value.cacheMode ?? "prefer-cache",
    maxAgeSeconds: value.maxAgeSeconds ?? config.defaultCacheSeconds,
    maxPages,
    maxDepth: value.maxDepth ?? 2,
    includeSubdomains: value.includeSubdomains ?? false,
    ignoreQueryParameters: value.ignoreQueryParameters ?? true,
    concurrency,
    budget,
    crawlBudget,
  };
}

function publicProgress(job: FrontierJob): NonNullable<CrawlJob["progress"]> {
  return {
    discoveredCount: job.progress.discovered,
    queuedCount: job.progress.queued,
    leasedCount: job.progress.leased,
    succeededCount: job.progress.succeeded,
    failedCount: job.progress.failed,
    stoppedCount: job.progress.stopped,
    publishedCount: job.progress.published,
  };
}

function usageFromArtifact(artifact: PageReadArtifact): CrawlResourceUsage {
  const attempts = artifact.evidence.fetchAttempts;
  const bytes = artifact.evidence.responseBytesByMethod;
  const durations = artifact.evidence.fetchDurationMsByMethod;
  return {
    providerAttempts: artifact.evidence.attempts ??
      ((attempts?.http ?? 0) + (attempts?.browser ?? 0)),
    documentBytesIn: bytes === undefined
      ? artifact.evidence.responseBytes
      : bytes.http + bytes.browser,
    networkBytesOut: 0,
    browserMilliseconds: Math.ceil(durations?.browser ?? 0),
    browserContextStarts: attempts?.browser ?? (artifact.fetchMethod === "browser" ? 1 : 0),
    retryDelayMilliseconds: artifact.evidence.totalRetryDelayMs ?? 0,
    optionalModelTokens: 0,
  };
}

function numericDetail(error: ReadError, name: string): number {
  const value = error.details[name];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function usageFromError(error: ReadError): CrawlResourceUsage {
  const httpAttempts = numericDetail(error, "httpFetchAttempts");
  const browserAttempts = numericDetail(error, "browserFetchAttempts");
  return {
    providerAttempts: httpAttempts + browserAttempts,
    documentBytesIn: numericDetail(error, "httpResponseBytes") +
      numericDetail(error, "browserResponseBytes"),
    networkBytesOut: 0,
    browserMilliseconds: Math.ceil(numericDetail(error, "browserFetchDurationMs")),
    browserContextStarts: browserAttempts,
    retryDelayMilliseconds: numericDetail(error, "totalRetryDelayMs"),
    optionalModelTokens: 0,
  };
}

function publicJob(job: FrontierJob): CrawlJob {
  const input = job.input as DurableCrawlOptions;
  const createdAt = new Date(job.createdAtMs).toISOString();
  const startedAt = job.startedAtMs === null ? null : new Date(job.startedAtMs).toISOString();
  const completedAt = job.completedAtMs === null ? null : new Date(job.completedAtMs).toISOString();
  const visibleStatus = job.status === "failed" && job.progress.leased > 0
    ? "running"
    : job.status;
  if (terminalStatuses.has(job.status) && completedAt === null) {
    throw new Error(`terminal crawl job ${job.id} is missing completed_at_ms`);
  }
  if (job.status === "completed" && startedAt === null) {
    throw new Error(`completed crawl job ${job.id} is missing started_at_ms`);
  }
  const result: CrawlSiteResult | null = job.status === "completed" ? {
    status: job.progress.failed + job.progress.stopped === 0 ? "ok" : "partial",
    sourceUrl: input.url,
    startedAt: startedAt!,
    completedAt: completedAt!,
    scannedPages: job.progress.published,
    pages: [],
    failures: [],
    truncated: job.truncated,
  } : null;
  return {
    id: job.id,
    status: visibleStatus,
    input,
    createdAt,
    startedAt,
    completedAt: terminalStatuses.has(visibleStatus) ? completedAt : null,
    result,
    error: job.error as CrawlJobError | null,
    progress: publicProgress(job),
    usage: job.usage,
    budget: job.budget,
    termination: (job.error as CrawlJob["termination"] | undefined) ?? null,
  };
}

export class DurableCrawlService {
  private readonly owner = randomUUID();
  private readonly activePages = new Map<string, ActivePage>();
  private wakeTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private drainAgain = false;
  private closing = false;

  constructor(
    private readonly store: FrontierStore,
    private readonly reader: ReaderService,
    private readonly urlPolicy: UrlPolicy,
    private readonly config: AppConfig,
    active = true,
  ) {
    if (active) this.wake();
  }

  start(raw: DurableCrawlOptions): CrawlJob {
    if (this.closing) throw new ReadError("INTERNAL_ERROR", "The crawl worker is shutting down.");
    const input = normalizedInput(this.config, raw);
    const root = this.urlPolicy.parse(input.url);
    input.url = siteSourceUrl(root, createSiteScope(root, input));
    const job = this.store.createJob({
      rootUrl: input.url,
      maxPages: input.maxPages ?? 10,
      input,
      ...(input.crawlBudget === undefined ? {} : { crawlBudget: input.crawlBudget }),
      ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    });
    this.wake();
    return publicJob(job);
  }

  get(id: string): CrawlJob {
    return publicJob(this.requireJob(id));
  }

  pause(id: string): CrawlJob {
    return publicJob(this.store.requestPause(this.requireJob(id).id));
  }

  resume(id: string): CrawlJob {
    const job = this.store.resume(this.requireJob(id).id);
    this.wake();
    return publicJob(job);
  }

  cancel(id: string): CrawlJob {
    const job = this.store.requestCancel(this.requireJob(id).id);
    for (const active of this.activePages.values()) {
      if (active.lease.page.crawlId === id) active.controller.abort(crawlCancelledError());
    }
    return publicJob(job);
  }

  pages(id: string, afterSequence: number, limit: number): CrawlPageBatch {
    this.requireJob(id);
    const batch = this.store.listPublications(id, afterSequence, limit);
    return {
      jobId: id,
      nextSequence: batch.nextSequence,
      done: batch.done,
      pages: batch.pages.map((publication): CrawlPagePublication => ({
        publicationSequence: publication.sequence,
        url: publication.page.normalizedUrl,
        depth: publication.page.depth,
        discoveredFrom: publication.page.discoveredFrom,
        status: publication.page.state as CrawlPagePublication["status"],
        result: publication.result as CrawlPagePublication["result"],
        error: publication.error as CrawlJobError | null,
      })),
    };
  }

  private requireJob(id: string): FrontierJob {
    const job = this.store.getJob(id);
    if (job === null) {
      throw new ReadError("JOB_NOT_FOUND", "The crawl job does not exist.", {
        details: { jobId: id },
      });
    }
    return job;
  }

  private wake(): void {
    if (this.closing) return;
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    if (this.closing) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      this.store.recoverExpiredLeases(undefined, this.owner);
      const runnableJobs = this.store.listRunnableJobs();
      const persistedLeases = runnableJobs.reduce(
        (total, job) => total + job.progress.leased,
        0,
      );
      let available = this.config.crawlWorkerConcurrency - persistedLeases;
      for (const job of runnableJobs) {
        const input = job.input as DurableCrawlOptions;
        let jobAvailable = Math.min(
          available,
          (input.concurrency ?? 4) - job.progress.leased,
        );
        while (jobAvailable > 0) {
          const lease = this.store.claimNext({
            crawlId: job.id,
            owner: this.owner,
            leaseMs: this.config.crawlLeaseMs,
            ...(input.budget === undefined ? {} : { requestedBudget: input.budget }),
            originIntervalMs: this.config.crawlMinHostIntervalMs,
          });
          if (lease === null) break;
          this.startLease(lease, input);
          available -= 1;
          jobAvailable -= 1;
        }
        if (available <= 0) break;
      }
      for (const job of this.store.listRunnableJobs()) this.finishIfDone(job.id);
    } finally {
      this.draining = false;
      if (this.drainAgain) {
        this.drainAgain = false;
        this.wake();
      } else this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.closing || this.wakeTimer !== null) return;
    const wakeAt = this.store.nextWakeAt(undefined, this.owner);
    if (wakeAt === null) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.drain();
    }, Math.max(0, Math.min(2_147_483_647, wakeAt - Date.now())));
  }

  private startLease(lease: FrontierLease, input: DurableCrawlOptions): void {
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      if (!this.store.heartbeat(lease, this.config.crawlLeaseMs)) controller.abort();
    }, Math.max(100, Math.floor(this.config.crawlLeaseMs / 3)));
    heartbeat.unref();
    const promise = this.executeLease(lease, input, controller.signal).finally(() => {
      clearInterval(heartbeat);
      this.activePages.delete(lease.page.id);
      this.finishIfDone(lease.page.crawlId);
      this.wake();
    });
    this.activePages.set(lease.page.id, { lease, controller, heartbeat, promise });
  }

  private async executeLease(
    lease: FrontierLease,
    input: DurableCrawlOptions,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (this.config.crawlMinHostIntervalMs > 0 &&
          !this.store.markOriginStarted(lease, this.config.crawlMinHostIntervalMs)) return;
      const artifact = await this.reader.crawlPageArtifact({
        url: lease.page.normalizedUrl,
        requestId: lease.page.id,
        cacheMode: input.cacheMode ?? "prefer-cache",
        maxAgeSeconds: input.maxAgeSeconds ?? this.config.defaultCacheSeconds,
        browserAllowed: input.browserAllowed ?? true,
        ...(input.authProfile === undefined ? {} : { authProfile: input.authProfile }),
        ...(input.browserReadiness === undefined ? {} : { browserReadiness: input.browserReadiness }),
        budget: lease.budgetSlice,
        signal,
      });
      const root = this.urlPolicy.parse(input.url);
      const scope = createSiteScope(root, input);
      const parent = {
        url: lease.page.normalizedUrl,
        depth: lease.page.depth,
        discoveredFrom: lease.page.discoveredFrom,
      };
      const discovered = lease.page.depth >= (input.maxDepth ?? 2) ? [] : artifact.discoveredLinks
        .flatMap((link) => {
          const candidate = normalizeDiscoveredLink(link, parent, scope);
          return candidate === null ? [] : [{
            requestedUrl: candidate.url,
            normalizedUrl: candidate.url,
            origin: new URL(candidate.url).origin,
            depth: candidate.depth,
            discoveredFrom: lease.page.normalizedUrl,
          }];
        });
      this.store.commitSuccess(lease, artifact, discovered, usageFromArtifact(artifact));
    } catch (error) {
      if (this.closing) {
        this.store.releaseLease(lease);
        return;
      }
      const cancelled = signal.aborted && this.store.isCancelRequested(lease.page.crawlId);
      const normalized = cancelled ? crawlCancelledError() : normalizeError(error);
      const retryAfterMs = normalized.details.retryAfterMs;
      if (normalized.code === "RATE_LIMITED" && typeof retryAfterMs === "number") {
        this.store.deferOrigin(
          lease.page.crawlId,
          lease.page.origin,
          Date.now() + retryAfterMs,
        );
      }
      const actual = usageFromError(normalized);
      if (cancelled) this.store.commitStopped(lease, normalized.toJSON(), actual);
      else this.store.commitFailure(lease, normalized.toJSON(), actual);
    }
  }

  private finishIfDone(id: string): void {
    const job = this.store.getJob(id);
    if (job === null || terminalStatuses.has(job.status) || job.status === "paused") return;
    if (job.progress.queued === 0 && job.progress.leased === 0) {
      this.store.setJobStatus(id, "completed");
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    for (const active of this.activePages.values()) active.controller.abort();
    await Promise.allSettled([...this.activePages.values()].map((active) => active.promise));
    this.store.close();
  }
}
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { crawlCancelledError, normalizeError, ReadError } from "../errors.js";
import type { FrontierStore } from "../frontier-store.js";
import type { ReaderService } from "../reader.js";
import type { UrlPolicy } from "../security/url-policy.js";
import { createSiteScope, normalizeDiscoveredLink, siteSourceUrl } from "../site-scope.js";
import type {
  CrawlJob,
  CrawlJobError,
  CrawlPageBatch,
  CrawlPagePublication,
  CrawlSiteResult,
  DurableCrawlOptions,
  ExecutionBudget,
  CrawlResourceUsage,
  PageReadArtifact,
} from "../types.js";
