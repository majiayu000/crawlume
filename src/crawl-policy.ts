import type { AppConfig } from "./config.js";
import { crawlCancelledError, ReadError } from "./errors.js";
import type { StageRetryPolicy } from "./types.js";

export type CrawlAttemptResult<T> = {
  value: T;
  attempts: number;
  totalRetryDelayMs: number;
};

export type CrawlPolicyRuntime = {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
};

export type CrawlExecutionHooks = {
  beforeRetryDelay?(milliseconds: number): void;
  onRetryDelay?(milliseconds: number): void;
};

type CrawlPolicyConfig = Pick<
  AppConfig,
  "crawlMaxAttempts" | "crawlRetryBaseMs" | "crawlMaxRetryDelayMs" | "crawlMinHostIntervalMs"
>;

const defaultRuntime: CrawlPolicyRuntime = {
  now: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    if (signal?.aborted === true) {
      throw crawlCancelledError();
    }
    if (milliseconds <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(crawlCancelledError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

function withAttemptEvidence(
  error: ReadError,
  attempts: number,
  totalRetryDelayMs: number,
  extraDetails: Record<string, boolean | number | string | null> = {},
): ReadError {
  return new ReadError(error.code, error.message, {
    retryable: error.retryable,
    details: {
      ...error.details,
      attempts,
      totalRetryDelayMs,
      ...extraDetails,
    },
    cause: error,
  });
}

export class CrawlRequestPolicy {
  private readonly nextHostStart = new Map<string, number>();

  constructor(
    private readonly config: CrawlPolicyConfig,
    private readonly runtime: CrawlPolicyRuntime = defaultRuntime,
  ) {}

  async execute<T>(
    url: URL,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    retryPolicy?: StageRetryPolicy,
    hooks?: CrawlExecutionHooks,
  ): Promise<CrawlAttemptResult<T>> {
    let attempts = 0;
    let totalRetryDelayMs = 0;
    const maxAttempts = retryPolicy?.maxAttempts ?? this.config.crawlMaxAttempts;
    while (attempts < maxAttempts) {
      await this.reserveHost(url.hostname, signal);
      attempts += 1;
      try {
        return {
          value: await operation(),
          attempts,
          totalRetryDelayMs,
        };
      } catch (error) {
        if (!(error instanceof ReadError)) {
          throw error;
        }
        if (signal?.aborted === true) {
          throw crawlCancelledError();
        }
        const retryAllowed = error.retryable &&
          (retryPolicy === undefined || retryPolicy.retryableErrorCodes.includes(error.code));
        if (!retryAllowed || attempts >= maxAttempts) {
          throw withAttemptEvidence(error, attempts, totalRetryDelayMs);
        }

        const retryAfterMs = typeof error.details.retryAfterMs === "number"
          ? error.details.retryAfterMs
          : 0;
        if (retryAfterMs > this.config.crawlMaxRetryDelayMs) {
          throw withAttemptEvidence(error, attempts, totalRetryDelayMs, {
            retryAfterExceedsLimit: true,
            maxRetryDelayMs: this.config.crawlMaxRetryDelayMs,
          });
        }
        const exponentialDelay = Math.min(
          this.config.crawlRetryBaseMs * 2 ** (attempts - 1),
          this.config.crawlMaxRetryDelayMs,
        );
        const retryDelay = Math.max(exponentialDelay, retryAfterMs);
        hooks?.beforeRetryDelay?.(retryDelay);
        totalRetryDelayMs += retryDelay;
        hooks?.onRetryDelay?.(retryDelay);
        await this.runtime.sleep(retryDelay, signal);
      }
    }

    throw new ReadError("INTERNAL_ERROR", "The crawl retry loop ended unexpectedly.");
  }

  private async reserveHost(hostname: string, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) {
      throw crawlCancelledError();
    }
    const host = hostname.toLowerCase();
    const now = this.runtime.now();
    const startAt = Math.max(now, this.nextHostStart.get(host) ?? now);
    this.nextHostStart.set(host, startAt + this.config.crawlMinHostIntervalMs);
    await this.runtime.sleep(startAt - now, signal);
  }
}
