import type { AppConfig } from "../config.js";
import { crawlCancelledError, ReadError } from "../errors.js";
import type { AccessProviderId } from "../types.js";

type GovernedProvider = Exclude<AccessProviderId, "cache" | "adapter">;
type PoolId = "http" | "browser" | "authorized";

export type ResourceGovernorRuntime = {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
};

export type RuntimeResourceRequest = {
  provider: GovernedProvider;
  origin: string;
  authProfile: string | null;
};

export type RuntimeResourceObservation = {
  durationMs: number;
  error: ReadError | null;
};

export type RuntimeResourceLease = {
  release(observation: RuntimeResourceObservation): Promise<void>;
};

type PoolState = {
  active: number;
  queued: number;
  limit: number;
  maximum: number;
  successStreak: number;
  samples: Array<{ durationMs: number; failed: boolean }>;
};

type OriginState = {
  active: number;
  cooldownUntilMs: number;
  circuitUntilMs: number;
  consecutiveFailures: number;
};

type Waiter = {
  wake(): void;
};

const maxWaiters = 1_024;
const sampleWindow = 32;
const circuitFailureThreshold = 3;
const circuitCooldownMs = 30_000;
const defaultOriginCooldownMs = 1_000;

const defaultRuntime: ResourceGovernorRuntime = {
  now: Date.now,
  sleep: async (milliseconds, signal) => {
    if (signal?.aborted === true) throw crawlCancelledError();
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

function initialLimit(maximum: number): number {
  return maximum;
}

function pool(maximum: number): PoolState {
  return {
    active: 0,
    queued: 0,
    limit: initialLimit(maximum),
    maximum,
    successStreak: 0,
    samples: [],
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function normalizedDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 2_147_483_647) : 0;
}

function poolId(request: RuntimeResourceRequest): PoolId {
  if (request.provider !== "browser") return "http";
  return request.authProfile === null ? "browser" : "authorized";
}

function normalizedOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ReadError("INVALID_ARGUMENT", "Runtime resource origin must be a valid URL origin.", {
      cause: error,
    });
  }
  if (parsed.origin !== value || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new ReadError("INVALID_ARGUMENT", "Runtime resource origin must be an HTTP(S) origin.");
  }
  return parsed.origin;
}

export class RuntimeResourceGovernor {
  private readonly pools: Record<PoolId, PoolState>;
  private readonly origins = new Map<string, OriginState>();
  private readonly activeProfiles = new Set<string>();
  private readonly waiters = new Set<Waiter>();
  private readonly maxOriginConcurrency: number;

  constructor(
    config: Pick<
      AppConfig,
      "crawlWorkerConcurrency" | "browserPoolSize" | "browserContextsPerInstance"
    >,
    private readonly runtime: ResourceGovernorRuntime = defaultRuntime,
  ) {
    this.maxOriginConcurrency = Math.min(16, config.crawlWorkerConcurrency);
    this.pools = {
      http: pool(config.crawlWorkerConcurrency),
      browser: pool(config.browserPoolSize * config.browserContextsPerInstance),
      authorized: pool(config.browserPoolSize),
    };
  }

  async acquire(
    rawRequest: RuntimeResourceRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeResourceLease> {
    const request = { ...rawRequest, origin: normalizedOrigin(rawRequest.origin) };
    const selectedPool = poolId(request);
    while (true) {
      if (signal?.aborted === true) throw crawlCancelledError();
      const origin = this.origin(request.origin);
      const now = this.runtime.now();
      if (origin.circuitUntilMs > now) {
        throw new ReadError("UPSTREAM_ERROR", "The origin circuit breaker is open.", {
          retryable: true,
          details: {
            circuitOpen: true,
            retryAfterMs: origin.circuitUntilMs - now,
          },
        });
      }
      const cooldownMs = Math.max(0, origin.cooldownUntilMs - now);
      if (cooldownMs > 0) {
        await this.wait(selectedPool, signal, cooldownMs);
        continue;
      }
      if (this.available(selectedPool, request, origin)) {
        return this.take(selectedPool, request, origin);
      }
      await this.wait(selectedPool, signal, 0);
    }
  }

  snapshot(): {
    pools: Record<PoolId, { active: number; queued: number; limit: number; maximum: number; samples: number }>;
  } {
    return {
      pools: Object.fromEntries(Object.entries(this.pools).map(([id, state]) => [id, {
        active: state.active,
        queued: state.queued,
        limit: state.limit,
        maximum: state.maximum,
        samples: state.samples.length,
      }])) as ReturnType<RuntimeResourceGovernor["snapshot"]>["pools"],
    };
  }

  private origin(key: string): OriginState {
    const existing = this.origins.get(key);
    if (existing !== undefined) return existing;
    const created: OriginState = {
      active: 0,
      cooldownUntilMs: 0,
      circuitUntilMs: 0,
      consecutiveFailures: 0,
    };
    this.origins.set(key, created);
    return created;
  }

  private available(
    selectedPool: PoolId,
    request: RuntimeResourceRequest,
    origin: OriginState,
  ): boolean {
    if (this.pools[selectedPool].active >= this.pools[selectedPool].limit) return false;
    if (origin.active >= this.maxOriginConcurrency) return false;
    return request.authProfile === null || !this.activeProfiles.has(request.authProfile);
  }

  private take(
    selectedPool: PoolId,
    request: RuntimeResourceRequest,
    origin: OriginState,
  ): RuntimeResourceLease {
    const selected = this.pools[selectedPool];
    selected.active += 1;
    origin.active += 1;
    if (request.authProfile !== null) this.activeProfiles.add(request.authProfile);
    let released = false;
    return {
      release: async (observation): Promise<void> => {
        if (released) return;
        released = true;
        selected.active = Math.max(0, selected.active - 1);
        origin.active = Math.max(0, origin.active - 1);
        if (request.authProfile !== null) this.activeProfiles.delete(request.authProfile);
        this.observePool(selected, observation);
        this.observeOrigin(origin, observation.error);
        this.notifyWaiters();
      },
    };
  }

  private observePool(poolState: PoolState, observation: RuntimeResourceObservation): void {
    const failed = observation.error?.retryable === true;
    poolState.samples.push({ durationMs: normalizedDuration(observation.durationMs), failed });
    if (poolState.samples.length > sampleWindow) poolState.samples.shift();
    if (failed) {
      poolState.limit = Math.max(1, Math.floor(poolState.limit / 2));
      poolState.successStreak = 0;
      return;
    }
    poolState.successStreak += 1;
    const durations = poolState.samples.map(({ durationMs }) => durationMs);
    const latencyDegraded = durations.length >= 8 &&
      percentile(durations, 0.95) > Math.max(100, percentile(durations, 0.5) * 2);
    if (latencyDegraded) {
      poolState.limit = Math.max(1, Math.floor(poolState.limit / 2));
      poolState.successStreak = 0;
      return;
    }
    if (
      poolState.limit < poolState.maximum &&
      poolState.successStreak >= poolState.limit * 2
    ) {
      poolState.limit += 1;
      poolState.successStreak = 0;
    }
  }

  private observeOrigin(origin: OriginState, error: ReadError | null): void {
    if (error === null || !error.retryable) {
      origin.consecutiveFailures = 0;
      return;
    }
    origin.consecutiveFailures += 1;
    const httpStatus = error.details.httpStatus;
    if (error.code === "RATE_LIMITED" || httpStatus === 503) {
      const retryAfterMs = typeof error.details.retryAfterMs === "number"
        ? Math.max(0, error.details.retryAfterMs)
        : defaultOriginCooldownMs;
      origin.cooldownUntilMs = Math.max(
        origin.cooldownUntilMs,
        this.runtime.now() + retryAfterMs,
      );
    }
    if (origin.consecutiveFailures >= circuitFailureThreshold) {
      origin.circuitUntilMs = this.runtime.now() + circuitCooldownMs;
    }
  }

  private async wait(selectedPool: PoolId, signal: AbortSignal | undefined, delayMs: number): Promise<void> {
    const totalQueued = Object.values(this.pools).reduce((total, state) => total + state.queued, 0);
    if (totalQueued >= maxWaiters) {
      throw new ReadError("PROVIDER_UNAVAILABLE", "The runtime resource queue is full.", {
        retryable: true,
        details: { providerPool: selectedPool, maxWaiters },
      });
    }
    const selected = this.pools[selectedPool];
    selected.queued += 1;
    try {
      if (delayMs > 0) {
        await this.runtime.sleep(delayMs, signal);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          this.waiters.delete(waiter);
          signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const waiter: Waiter = { wake: () => finish(resolve) };
        const onAbort = (): void => finish(() => reject(crawlCancelledError()));
        this.waiters.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      selected.queued = Math.max(0, selected.queued - 1);
    }
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.wake();
  }
}
