import { describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
import {
  RuntimeResourceGovernor,
  type ResourceGovernorRuntime,
} from "../src/runtime/runtime-resource-governor.js";
import { testConfig } from "./helpers.js";

class FakeRuntime implements ResourceGovernorRuntime {
  private time = 0;
  private readonly sleepers: Array<{ dueAt: number; resolve(): void }> = [];

  now = (): number => this.time;

  sleep = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted === true) throw new ReadError("CRAWL_CANCELLED", "cancelled");
    await new Promise<void>((resolve, reject) => {
      const sleeper = { dueAt: this.time + milliseconds, resolve };
      this.sleepers.push(sleeper);
      signal?.addEventListener("abort", () => reject(
        new ReadError("CRAWL_CANCELLED", "cancelled"),
      ), { once: true });
    });
  };

  advance(milliseconds: number): void {
    this.time += milliseconds;
    for (const sleeper of this.sleepers.splice(0)) {
      if (sleeper.dueAt <= this.time) sleeper.resolve();
      else this.sleepers.push(sleeper);
    }
  }
}

function governor(
  runtime = new FakeRuntime(),
  overrides: Partial<ReturnType<typeof testConfig>> = {},
): RuntimeResourceGovernor {
  return new RuntimeResourceGovernor({ ...testConfig(), ...overrides }, runtime);
}

const http = { provider: "http" as const, origin: "https://one.example", authProfile: null };
const browser = { provider: "browser" as const, origin: "https://one.example", authProfile: null };

describe("RuntimeResourceGovernor", () => {
  it("keeps HTTP and anonymous Browser capacity in independent queues", async () => {
    const resources = governor(undefined, {
      crawlWorkerConcurrency: 1,
      browserPoolSize: 1,
      browserContextsPerInstance: 1,
    });
    const activeHttp = await resources.acquire(http);
    let nextHttpStarted = false;
    const nextHttp = resources.acquire({ ...http, origin: "https://two.example" }).then((lease) => {
      nextHttpStarted = true;
      return lease;
    });
    const activeBrowser = await resources.acquire({ ...browser, origin: "https://browser.example" });

    expect(nextHttpStarted).toBe(false);
    expect(resources.snapshot().pools).toMatchObject({
      http: { active: 1, queued: 1 },
      browser: { active: 1, queued: 0 },
    });
    await activeHttp.release({ durationMs: 10, error: null });
    await (await nextHttp).release({ durationMs: 10, error: null });
    await activeBrowser.release({ durationMs: 10, error: null });
  });

  it("limits each origin to 16 in-flight requests without blocking another origin", async () => {
    const resources = governor(undefined, { crawlWorkerConcurrency: 32 });
    const active = await Promise.all(Array.from(
      { length: 16 },
      async () => resources.acquire(http),
    ));
    let overflowStarted = false;
    const overflow = resources.acquire(http).then((lease) => {
      overflowStarted = true;
      return lease;
    });
    const otherOrigin = await resources.acquire({ ...http, origin: "https://two.example" });

    expect(overflowStarted).toBe(false);
    await active.pop()!.release({ durationMs: 10, error: null });
    await (await overflow).release({ durationMs: 10, error: null });
    await Promise.all(active.map(async (lease) => lease.release({ durationMs: 10, error: null })));
    await otherOrigin.release({ durationMs: 10, error: null });
  });

  it("serializes the same authorization profile while allowing another profile", async () => {
    const resources = governor(undefined, { browserPoolSize: 2 });
    const work = await resources.acquire({ ...browser, authProfile: "work" });
    let sameProfileStarted = false;
    const sameProfile = resources.acquire({ ...browser, authProfile: "work" }).then((lease) => {
      sameProfileStarted = true;
      return lease;
    });
    const research = await resources.acquire({ ...browser, authProfile: "research" });

    expect(sameProfileStarted).toBe(false);
    await work.release({ durationMs: 10, error: null });
    await (await sameProfile).release({ durationMs: 10, error: null });
    await research.release({ durationMs: 10, error: null });
  });

  it.each([
    new ReadError("RATE_LIMITED", "limited", { retryable: true, details: { retryAfterMs: 500 } }),
    new ReadError("UPSTREAM_ERROR", "unavailable", {
      retryable: true,
      details: { httpStatus: 503, retryAfterMs: 500 },
    }),
  ])("pauses only the affected origin after 429/503 feedback", async (error) => {
    const runtime = new FakeRuntime();
    const resources = governor(runtime, { crawlWorkerConcurrency: 3 });
    const failed = await resources.acquire(http);
    await failed.release({ durationMs: 10, error });
    let resumed = false;
    const pending = resources.acquire(http).then((lease) => {
      resumed = true;
      return lease;
    });
    const other = await resources.acquire({ ...http, origin: "https://two.example" });
    await Promise.resolve();
    expect(resumed).toBe(false);

    await other.release({ durationMs: 10, error: null });
    runtime.advance(500);
    await (await pending).release({ durationMs: 10, error: null });
  });

  it("opens a circuit after three retryable origin failures and closes it after cooldown", async () => {
    const runtime = new FakeRuntime();
    const resources = governor(runtime);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lease = await resources.acquire(http);
      await lease.release({
        durationMs: 10,
        error: new ReadError("UPSTREAM_ERROR", "failed", { retryable: true }),
      });
    }

    await expect(resources.acquire(http)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: true,
      details: { circuitOpen: true, retryAfterMs: 30_000 },
    });
    runtime.advance(30_000);
    const recovered = await resources.acquire(http);
    await recovered.release({ durationMs: 10, error: null });
  });

  it("uses bounded AIMD feedback for successes, latency, and failures", async () => {
    const resources = governor(undefined, { crawlWorkerConcurrency: 4 });
    expect(resources.snapshot().pools.http.limit).toBe(4);
    for (let sample = 0; sample < 8; sample += 1) {
      const lease = await resources.acquire({ ...http, origin: `https://${sample}.example` });
      await lease.release({ durationMs: sample === 7 ? 1_000 : 10, error: null });
    }
    const afterLatency = resources.snapshot().pools.http.limit;
    expect(afterLatency).toBeLessThan(4);

    const failed = await resources.acquire({ ...http, origin: "https://failure.example" });
    await failed.release({
      durationMs: 10,
      error: new ReadError("UPSTREAM_ERROR", "failed", { retryable: true }),
    });
    expect(resources.snapshot().pools.http.limit).toBeLessThanOrEqual(afterLatency);

    for (let sample = 0; sample < 40; sample += 1) {
      const lease = await resources.acquire({ ...http, origin: `https://ok-${sample}.example` });
      await lease.release({ durationMs: 10, error: null });
    }
    expect(resources.snapshot().pools.http.samples).toBeLessThanOrEqual(32);
    expect(resources.snapshot().pools.http.limit).toBeLessThanOrEqual(4);
  });

  it("cancels queued backpressure without consuming a capacity slot", async () => {
    const resources = governor(undefined, { crawlWorkerConcurrency: 1 });
    const active = await resources.acquire(http);
    const controller = new AbortController();
    const pending = resources.acquire({ ...http, origin: "https://two.example" }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "CRAWL_CANCELLED" });
    expect(resources.snapshot().pools.http).toMatchObject({ active: 1, queued: 0 });
    await active.release({ durationMs: 10, error: null });
  });

  it("fails visibly when the bounded backpressure queue is full", async () => {
    const resources = governor(undefined, { crawlWorkerConcurrency: 1 });
    const active = await resources.acquire(http);
    const controllers = Array.from({ length: 1_024 }, () => new AbortController());
    const queued = controllers.map((controller, index) => resources.acquire({
      ...http,
      origin: `https://queued-${index}.example`,
    }, controller.signal));

    await expect(resources.acquire({
      ...http,
      origin: "https://overflow.example",
    })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      details: { providerPool: "http", maxWaiters: 1_024 },
    });

    for (const controller of controllers) controller.abort();
    await Promise.allSettled(queued);
    await active.release({ durationMs: 10, error: null });
  });
});
