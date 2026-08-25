import { describe, expect, it, vi } from "vitest";

import { CrawlRequestPolicy, type CrawlPolicyRuntime } from "../src/crawl-policy.js";
import { ReadError } from "../src/errors.js";

function config(overrides: Partial<ConstructorParameters<typeof CrawlRequestPolicy>[0]> = {}) {
  return {
    crawlMaxAttempts: 3,
    crawlRetryBaseMs: 100,
    crawlMaxRetryDelayMs: 2_000,
    crawlMinHostIntervalMs: 0,
    ...overrides,
  };
}

function fakeRuntime(): CrawlPolicyRuntime & { sleeps: number[]; time: number } {
  return {
    time: 0,
    sleeps: [],
    now() {
      return this.time;
    },
    async sleep(milliseconds) {
      this.sleeps.push(milliseconds);
      this.time += milliseconds;
    },
  };
}

describe("CrawlRequestPolicy", () => {
  it("recovers from retryable failures with bounded exponential backoff", async () => {
    const runtime = fakeRuntime();
    const policy = new CrawlRequestPolicy(config(), runtime);
    const operation = vi.fn()
      .mockRejectedValueOnce(new ReadError("UPSTREAM_ERROR", "temporary", { retryable: true }))
      .mockRejectedValueOnce(new ReadError("FETCH_TIMEOUT", "temporary", { retryable: true }))
      .mockResolvedValue("ok");

    const outcome = await policy.execute(new URL("https://example.com/page"), operation);

    expect(outcome).toEqual({ value: "ok", attempts: 3, totalRetryDelayMs: 300 });
    expect(runtime.sleeps.filter((milliseconds) => milliseconds > 0)).toEqual([100, 200]);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry access failures and adds final attempt evidence", async () => {
    const runtime = fakeRuntime();
    const policy = new CrawlRequestPolicy(config(), runtime);
    const operation = vi.fn(async () => {
      throw new ReadError("ACCESS_DENIED", "denied");
    });

    await expect(
      policy.execute(new URL("https://example.com/private"), operation),
    ).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      details: { attempts: 1, totalRetryDelayMs: 0 },
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("preserves the final retryable error after the attempt limit", async () => {
    const runtime = fakeRuntime();
    const policy = new CrawlRequestPolicy(config(), runtime);
    const operation = vi.fn(async () => {
      throw new ReadError("RATE_LIMITED", "limited", { retryable: true });
    });

    await expect(
      policy.execute(new URL("https://example.com/page"), operation),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { attempts: 3, totalRetryDelayMs: 300 },
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("reserves separate start slots for the same host without blocking other hosts", async () => {
    const runtime = fakeRuntime();
    const policy = new CrawlRequestPolicy(config({ crawlMinHostIntervalMs: 250 }), runtime);

    await Promise.all([
      policy.execute(new URL("https://example.com/one"), async () => "one"),
      policy.execute(new URL("https://example.com/two"), async () => "two"),
      policy.execute(new URL("https://other.example/three"), async () => "three"),
    ]);

    expect(runtime.sleeps).toContain(250);
    expect(runtime.sleeps.filter((milliseconds) => milliseconds === 0)).toHaveLength(2);
  });

  it("honors Retry-After when it is within the configured maximum", async () => {
    const runtime = fakeRuntime();
    const policy = new CrawlRequestPolicy(config(), runtime);
    const operation = vi.fn()
      .mockRejectedValueOnce(new ReadError("RATE_LIMITED", "limited", {
        retryable: true,
        details: { retryAfterMs: 1_500 },
      }))
      .mockResolvedValue("ok");

    const outcome = await policy.execute(new URL("https://example.com/page"), operation);

    expect(outcome.totalRetryDelayMs).toBe(1_500);
    expect(runtime.sleeps).toContain(1_500);
  });

  it("does not retry before a Retry-After value beyond the configured maximum", async () => {
    const runtime = fakeRuntime();
    const policy = new CrawlRequestPolicy(config({ crawlMaxRetryDelayMs: 1_000 }), runtime);
    const operation = vi.fn(async () => {
      throw new ReadError("RATE_LIMITED", "limited", {
        retryable: true,
        details: { retryAfterMs: 10_000 },
      });
    });

    await expect(
      policy.execute(new URL("https://example.com/page"), operation),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterExceedsLimit: true, maxRetryDelayMs: 1_000 },
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("interrupts retry waiting when a crawl is cancelled", async () => {
    const policy = new CrawlRequestPolicy(config({ crawlRetryBaseMs: 10_000 }));
    const controller = new AbortController();
    const pending = policy.execute(
      new URL("https://example.com/page"),
      async () => {
        throw new ReadError("UPSTREAM_ERROR", "temporary", { retryable: true });
      },
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "CRAWL_CANCELLED" });
  });
});
