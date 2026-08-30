import { normalizeError, ReadError } from "./errors.js";
import { PageMonitorStore } from "./monitor-store.js";
import type {
  PageMonitor,
  PageMonitorInput,
  PageReadArtifact,
} from "./types.js";

export { PageMonitorStore } from "./monitor-store.js";

type MonitorReader = {
  readPageArtifact(options: PageMonitorInput & {
    cacheMode: "live";
    signal?: AbortSignal;
  }): Promise<PageReadArtifact>;
};

type MonitorValidator = {
  parse(rawUrl: string): URL;
  assertPublic(url: URL): Promise<unknown>;
};

export type MonitorRuntime = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
};

const minimumIntervalSeconds = 60;
const maximumIntervalSeconds = 604_800;
const maximumTimerDelayMs = 2_147_483_647;

const defaultRuntime: MonitorRuntime = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

export class PageMonitorService {
  private worker: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: { id: string; controller: AbortController } | null = null;
  private workerFailure: ReadError | null = null;
  private closing = false;

  constructor(
    private readonly store: PageMonitorStore,
    private readonly reader: MonitorReader,
    private readonly validator: MonitorValidator,
    private readonly active = true,
    private readonly runtime: MonitorRuntime = defaultRuntime,
  ) {
    if (this.active) {
      this.store.recoverInterrupted();
      this.scheduleNext();
    }
  }

  async start(input: PageMonitorInput, intervalSeconds: number): Promise<PageMonitor> {
    this.throwIfWorkerFailed();
    if (this.closing) {
      throw new ReadError("INTERNAL_ERROR", "The page monitor worker is shutting down.");
    }
    if (!this.active) {
      throw new ReadError("INTERNAL_ERROR", "The page monitor worker is not active in this process.");
    }
    if (
      !Number.isSafeInteger(intervalSeconds) ||
      intervalSeconds < minimumIntervalSeconds ||
      intervalSeconds > maximumIntervalSeconds
    ) {
      throw new ReadError(
        "INVALID_ARGUMENT",
        `intervalSeconds must be an integer between ${minimumIntervalSeconds} and ${maximumIntervalSeconds}.`,
        { details: { intervalSeconds } },
      );
    }
    const browserAllowed = input.browserAllowed ?? true;
    if (input.authProfile !== undefined && !browserAllowed) {
      throw new ReadError("INVALID_ARGUMENT", "authProfile requires browser access.");
    }
    const url = this.validator.parse(input.url);
    await this.validator.assertPublic(url);
    const normalizedInput: PageMonitorInput = {
      url: url.toString(),
      browserAllowed,
      ...(input.authProfile === undefined ? {} : { authProfile: input.authProfile }),
    };
    const monitor = this.store.create(normalizedInput, intervalSeconds);
    this.reschedule();
    return monitor;
  }

  get(id: string): PageMonitor {
    this.throwIfWorkerFailed();
    return this.store.require(id);
  }

  list(limit = 20): PageMonitor[] {
    this.throwIfWorkerFailed();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ReadError("INVALID_ARGUMENT", "limit must be an integer between 1 and 100.", {
        details: { limit },
      });
    }
    return this.store.list(limit);
  }

  cancel(id: string): PageMonitor {
    this.throwIfWorkerFailed();
    const monitor = this.store.cancel(id);
    if (this.current?.id === id) {
      this.current.controller.abort();
    }
    this.reschedule();
    return monitor;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer !== null) {
      this.runtime.clearTimer(this.timer);
      this.timer = null;
    }
    this.current?.controller.abort();
    await this.worker;
    this.store.close();
    if (this.workerFailure !== null) {
      throw this.workerFailure;
    }
  }

  private reschedule(): void {
    if (this.timer !== null) {
      this.runtime.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.worker === null) {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.closing || !this.active || this.workerFailure !== null) {
      return;
    }
    const nextDueAt = this.store.nextDueAt();
    if (nextDueAt === null) {
      return;
    }
    const delayMs = Math.max(0, Math.min(nextDueAt - this.runtime.now(), maximumTimerDelayMs));
    if (delayMs === 0) {
      this.wake();
      return;
    }
    this.timer = this.runtime.setTimer(() => {
      this.timer = null;
      this.wake();
    }, delayMs);
  }

  private wake(): void {
    if (this.closing || this.worker !== null || this.workerFailure !== null) {
      return;
    }
    this.worker = this.drain()
      .catch((error: unknown) => {
        this.workerFailure = normalizeError(error);
      })
      .finally(() => {
        this.worker = null;
        this.scheduleNext();
      });
  }

  private async drain(): Promise<void> {
    while (!this.closing) {
      const monitor = this.store.claimDue();
      if (monitor === null) {
        return;
      }
      const controller = new AbortController();
      this.current = { id: monitor.id, controller };
      const startedAt = new Date(this.runtime.now()).toISOString();
      try {
        const artifact = await this.reader.readPageArtifact({
          ...monitor.input,
          cacheMode: "live",
          signal: controller.signal,
        });
        const completedAt = new Date(this.runtime.now()).toISOString();
        if (this.closing) {
          this.store.requeue(monitor.id);
        } else if (controller.signal.aborted || this.store.isCancelled(monitor.id)) {
          // Cancellation already persisted the terminal state.
        } else {
          const previousContentHash = monitor.lastContentHash;
          const changed = previousContentHash === null
            ? null
            : previousContentHash !== artifact.contentHash;
          const {
            contentMarkdown: _contentMarkdown,
            discoveredLinks: _discoveredLinks,
            ...page
          } = artifact;
          this.store.completeSuccess(monitor.id, {
            status: "ok",
            startedAt,
            completedAt,
            changed,
            previousContentHash,
            contentHash: artifact.contentHash,
            page,
          });
        }
      } catch (error) {
        if (this.closing) {
          this.store.requeue(monitor.id);
        } else if (controller.signal.aborted || this.store.isCancelled(monitor.id)) {
          // Cancellation already persisted the terminal state.
        } else {
          const normalized = normalizeError(error);
          this.store.completeFailure(monitor.id, {
            status: "error",
            startedAt,
            completedAt: new Date(this.runtime.now()).toISOString(),
            error: {
              code: normalized.code,
              message: normalized.message,
              retryable: normalized.retryable,
              details: normalized.details,
            },
          });
        }
      } finally {
        this.current = null;
      }
    }
  }

  private throwIfWorkerFailed(): void {
    if (this.workerFailure !== null) {
      throw this.workerFailure;
    }
  }
}
