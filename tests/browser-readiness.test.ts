import { describe, expect, it } from "vitest";

import {
  waitForTargetReadiness,
  waitForBrowserReadiness,
  type BrowserReadinessRuntime,
  type BrowserReadinessSnapshot,
  type BrowserTargetReadinessRuntime,
} from "../src/runtime/readiness.js";

function runtimeFor(
  snapshotAt: (nowMs: number) => BrowserReadinessSnapshot,
): BrowserReadinessRuntime & { elapsedMs: () => number } {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sample: async () => snapshotAt(nowMs),
    wait: async (milliseconds) => {
      nowMs += milliseconds;
    },
    elapsedMs: () => nowMs,
  };
}

describe("waitForBrowserReadiness", () => {
  it("waits for delayed meaningful content instead of accepting an early stable shell", async () => {
    const runtime = runtimeFor((nowMs) =>
      nowMs < 900
        ? { readyState: "complete", textCharacters: 20, htmlCharacters: 100 }
        : { readyState: "complete", textCharacters: 800, htmlCharacters: 1_500 },
    );

    const result = await waitForBrowserReadiness(runtime, {
      timeoutMs: 3_000,
      pollIntervalMs: 100,
      stableWindowMs: 300,
      minContentCharacters: 500,
      shortPageGraceMs: 2_000,
    });

    expect(result.reason).toBe("meaningful-content-stable");
    expect(result.waitedMs).toBe(1_200);
    expect(result.textCharacters).toBe(800);
    expect(runtime.elapsedMs()).toBeGreaterThan(750);
  });

  it("accepts a genuinely short stable page after the short-page grace period", async () => {
    const runtime = runtimeFor(() => ({
      readyState: "complete",
      textCharacters: 120,
      htmlCharacters: 300,
    }));

    const result = await waitForBrowserReadiness(runtime, {
      timeoutMs: 3_000,
      pollIntervalMs: 100,
      stableWindowMs: 300,
      minContentCharacters: 500,
      shortPageGraceMs: 2_000,
    });

    expect(result.reason).toBe("short-page-grace-elapsed");
    expect(result.waitedMs).toBe(2_000);
  });

  it("fails with FETCH_TIMEOUT when the DOM never becomes stable", async () => {
    const runtime = runtimeFor((nowMs) => ({
      readyState: "complete",
      textCharacters: 800 + nowMs,
      htmlCharacters: 1_500 + nowMs,
    }));

    await expect(
      waitForBrowserReadiness(runtime, {
        timeoutMs: 1_000,
        pollIntervalMs: 100,
        stableWindowMs: 300,
        minContentCharacters: 500,
        shortPageGraceMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: "FETCH_TIMEOUT", retryable: true });
  });

  it("fails with CRAWL_CANCELLED when the caller aborts readiness polling", async () => {
    const controller = new AbortController();
    const runtime = runtimeFor(() => ({
      readyState: "interactive",
      textCharacters: 20,
      htmlCharacters: 100,
    }));
    controller.abort();

    await expect(
      waitForBrowserReadiness(runtime, {
        timeoutMs: 3_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CRAWL_CANCELLED" });
  });
});

describe("waitForTargetReadiness", () => {
  it("waits for an explicit terminal selector instead of accepting stable body text", async () => {
    const base = runtimeFor(() => ({
      readyState: "complete",
      textCharacters: 800,
      htmlCharacters: 1_500,
    }));
    const runtime: BrowserTargetReadinessRuntime = {
      ...base,
      countTarget: async () => base.elapsedMs() >= 900 ? 1 : 0,
      performInteraction: async () => undefined,
    };

    const result = await waitForTargetReadiness(runtime, {
      target: { selector: "[data-terminal='true']" },
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 100,
    });

    expect(result).toMatchObject({
      reason: "target-condition-met",
      waitedMs: 900,
      targetMatches: 1,
      interactionSteps: 0,
    });
  });

  it("uses only the declared scroll budget while waiting for the terminal target", async () => {
    const base = runtimeFor(() => ({
      readyState: "complete",
      textCharacters: 800,
      htmlCharacters: 1_500,
    }));
    let interactionSteps = 0;
    const runtime: BrowserTargetReadinessRuntime = {
      ...base,
      countTarget: async () => interactionSteps >= 3 ? 1 : 0,
      performInteraction: async () => {
        interactionSteps += 1;
      },
    };

    const result = await waitForTargetReadiness(runtime, {
      target: { selector: "[data-terminal='true']" },
      interaction: { type: "scroll-to-end", maxSteps: 4, stepDelayMs: 50 },
    }, { timeoutMs: 2_000 });

    expect(result.interactionSteps).toBe(3);
    expect(interactionSteps).toBe(3);
  });

  it("fails visibly when the interaction budget is exhausted before the target appears", async () => {
    const base = runtimeFor(() => ({
      readyState: "complete",
      textCharacters: 800,
      htmlCharacters: 1_500,
    }));
    const runtime: BrowserTargetReadinessRuntime = {
      ...base,
      countTarget: async () => 0,
      performInteraction: async () => undefined,
    };

    await expect(waitForTargetReadiness(runtime, {
      target: { selector: "[data-terminal='true']" },
      interaction: { type: "scroll-to-end", maxSteps: 2, stepDelayMs: 50 },
    }, { timeoutMs: 2_000 })).rejects.toMatchObject({
      code: "FETCH_TIMEOUT",
      details: { interactionSteps: 2, maxInteractionSteps: 2 },
    });
  });

  it("does not accept a target that appears only after an interaction crosses the deadline", async () => {
    const base = runtimeFor(() => ({
      readyState: "complete",
      textCharacters: 800,
      htmlCharacters: 1_500,
    }));
    const runtime: BrowserTargetReadinessRuntime = {
      ...base,
      countTarget: async () => base.elapsedMs() >= 150 ? 1 : 0,
      performInteraction: async () => base.wait(150),
    };

    await expect(waitForTargetReadiness(runtime, {
      target: { selector: "[data-terminal='true']" },
      interaction: { type: "scroll-to-end", maxSteps: 1, stepDelayMs: 0 },
    }, { timeoutMs: 100 })).rejects.toMatchObject({
      code: "FETCH_TIMEOUT",
      details: { timeoutMs: 100 },
    });
  });
});
