import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { crawlCancelledError, ReadError } from "../src/errors.js";
import {
  PageMonitorService,
  PageMonitorStore,
  type MonitorRuntime,
} from "../src/monitors.js";
import type { PageReadArtifact } from "../src/types.js";

const services: PageMonitorService[] = [];
const temporaryDirectories: string[] = [];

function artifact(contentHash: string): PageReadArtifact {
  return {
    status: "ok",
    sourceUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    fetchedAt: "2026-08-25T00:00:00.000Z",
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "Example article",
    byline: null,
    publishedTime: null,
    contentMarkdown: "Complete article content.",
    contentHash,
    completeness: "complete",
    validation: { outcome: "valid", validatorVersion: "generic-content-v1", checks: [], terminalError: null },
    discoveredLinks: [],
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 123,
      contentCharacters: 400,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId: "request-test",
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{
          stageId: "http-read",
          provider: "http",
          reasonCode: "HTTP_PRIMARY",
        }],
        executedStages: ["http-read"],
      },
      attempts: 1,
      totalRetryDelayMs: 0,
    },
  };
}

class ManualRuntime implements MonitorRuntime {
  private sequence = 0;
  private readonly timers = new Map<ReturnType<typeof setTimeout>, {
    callback: () => void;
    at: number;
  }>();

  constructor(private currentTime: number) {}

  now(): number {
    return this.currentTime;
  }

  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = { id: this.sequence += 1 } as unknown as ReturnType<typeof setTimeout>;
    this.timers.set(handle, { callback, at: this.currentTime + delayMs });
    return handle;
  }

  clearTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer);
  }

  pendingCount(): number {
    return this.timers.size;
  }

  nextDelayMs(): number | null {
    const next = [...this.timers.values()].sort((left, right) => left.at - right.at)[0];
    return next === undefined ? null : next.at - this.currentTime;
  }

  fireNext(): void {
    const entry = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (entry === undefined) {
      throw new Error("No monitor timer is pending.");
    }
    const [handle, timer] = entry;
    this.timers.delete(handle);
    this.currentTime = timer.at;
    timer.callback();
  }
}

function validator() {
  return {
    parse(raw: string) {
      return new URL(raw);
    },
    async assertPublic() {
      return undefined;
    },
  };
}

afterEach(async () => {
  while (services.length > 0) {
    await services.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("PageMonitorService", () => {
  it("establishes a baseline, detects unchanged content, then records a change", async () => {
    const runtime = new ManualRuntime(Date.parse("2026-08-25T00:00:00.000Z"));
    const responses = [artifact("hash-a"), artifact("hash-a"), artifact("hash-b")];
    const inputs: Array<Record<string, unknown>> = [];
    const reader = {
      async readPageArtifact(input: Record<string, unknown>) {
        inputs.push(input);
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("Monitor response sequence exhausted.");
        }
        return response;
      },
    };
    const service = new PageMonitorService(
      new PageMonitorStore(":memory:", () => runtime.now()),
      reader,
      validator(),
      true,
      runtime,
    );
    services.push(service);

    const created = await service.start({ url: "https://example.com/article" }, 60);
    await vi.waitFor(() => expect(service.get(created.id).runCount).toBe(1));
    await vi.waitFor(() => expect(runtime.pendingCount()).toBe(1));
    expect(service.get(created.id).lastRun).toMatchObject({
      status: "ok",
      changed: null,
      previousContentHash: null,
      contentHash: "hash-a",
    });
    expect(runtime.nextDelayMs()).toBe(60_000);

    runtime.fireNext();
    await vi.waitFor(() => expect(service.get(created.id).runCount).toBe(2));
    await vi.waitFor(() => expect(runtime.pendingCount()).toBe(1));
    expect(service.get(created.id).lastRun).toMatchObject({
      status: "ok",
      changed: false,
      contentHash: "hash-a",
    });

    runtime.fireNext();
    await vi.waitFor(() => expect(service.get(created.id).runCount).toBe(3));
    expect(service.get(created.id)).toMatchObject({
      status: "scheduled",
      lastContentHash: "hash-b",
      runCount: 3,
      changeCount: 1,
      failureCount: 0,
      lastRun: {
        status: "ok",
        changed: true,
        previousContentHash: "hash-a",
        contentHash: "hash-b",
      },
    });
    expect(service.get(created.id).lastChangedAt).not.toBeNull();
    expect(inputs).toHaveLength(3);
    expect(inputs.every((input) => input.cacheMode === "live")).toBe(true);
  });

  it("records a failed run without losing the baseline or stopping future scheduling", async () => {
    const runtime = new ManualRuntime(Date.parse("2026-08-25T00:00:00.000Z"));
    const responses: Array<PageReadArtifact | ReadError> = [
      new ReadError("ACCESS_DENIED", "denied"),
      artifact("hash-a"),
    ];
    const service = new PageMonitorService(
      new PageMonitorStore(":memory:", () => runtime.now()),
      {
        async readPageArtifact() {
          const response = responses.shift();
          if (response instanceof Error) {
            throw response;
          }
          if (response === undefined) {
            throw new Error("Monitor response sequence exhausted.");
          }
          return response;
        },
      },
      validator(),
      true,
      runtime,
    );
    services.push(service);

    const created = await service.start({ url: "https://example.com/article" }, 60);
    await vi.waitFor(() => expect(service.get(created.id).failureCount).toBe(1));
    await vi.waitFor(() => expect(runtime.pendingCount()).toBe(1));
    expect(service.get(created.id)).toMatchObject({
      status: "scheduled",
      runCount: 1,
      failureCount: 1,
      lastContentHash: null,
      lastRun: { status: "error", error: { code: "ACCESS_DENIED" } },
    });

    runtime.fireNext();
    await vi.waitFor(() => expect(service.get(created.id).runCount).toBe(2));
    expect(service.get(created.id)).toMatchObject({
      status: "scheduled",
      runCount: 2,
      failureCount: 1,
      lastContentHash: "hash-a",
      lastRun: { status: "ok", changed: null },
    });
  });

  it("cooperatively cancels a running monitor and never schedules it again", async () => {
    const runtime = new ManualRuntime(Date.parse("2026-08-25T00:00:00.000Z"));
    let receivedSignal: AbortSignal | undefined;
    const service = new PageMonitorService(
      new PageMonitorStore(":memory:", () => runtime.now()),
      {
        async readPageArtifact(input) {
          receivedSignal = input.signal;
          await new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(crawlCancelledError()), {
              once: true,
            });
          });
          throw new Error("unreachable");
        },
      },
      validator(),
      true,
      runtime,
    );
    services.push(service);

    const created = await service.start({ url: "https://example.com/article" }, 60);
    await vi.waitFor(() => expect(service.get(created.id).status).toBe("running"));
    expect(service.cancel(created.id).status).toBe("cancelled");
    expect(receivedSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(service.get(created.id).status).toBe("cancelled"));
    expect(service.get(created.id).nextRunAt).toBeNull();
    expect(runtime.pendingCount()).toBe(0);
  });

  it("requeues a running monitor during service shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-monitor-shutdown-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "crawler.sqlite");
    const runtime = new ManualRuntime(Date.parse("2026-08-25T00:00:00.000Z"));
    const service = new PageMonitorService(
      new PageMonitorStore(path, () => runtime.now()),
      {
        async readPageArtifact(input) {
          await new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(crawlCancelledError()), {
              once: true,
            });
          });
          throw new Error("unreachable");
        },
      },
      validator(),
      true,
      runtime,
    );
    const created = await service.start({ url: "https://example.com/article" }, 60);
    await vi.waitFor(() => expect(service.get(created.id).status).toBe("running"));
    await service.close();

    const reopened = new PageMonitorStore(path, () => runtime.now());
    expect(reopened.require(created.id)).toMatchObject({
      status: "scheduled",
      startedAt: null,
      nextRunAt: "2026-08-25T00:00:00.000Z",
      runCount: 0,
    });
    reopened.close();
  });

  it("validates intervals, profile mode, list limits, and missing IDs", async () => {
    const runtime = new ManualRuntime(Date.parse("2026-08-25T00:00:00.000Z"));
    const service = new PageMonitorService(
      new PageMonitorStore(":memory:", () => runtime.now()),
      { async readPageArtifact() { return artifact("hash"); } },
      validator(),
      true,
      runtime,
    );
    services.push(service);

    await expect(service.start({ url: "https://example.com" }, 59)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(service.start({
      url: "https://example.com",
      browserAllowed: false,
      authProfile: "work",
    }, 60)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(() => service.list(101)).toThrow("between 1 and 100");
    expect(() => service.get("00000000-0000-4000-8000-000000000001")).toThrowError(
      expect.objectContaining({ code: "MONITOR_NOT_FOUND" }),
    );
  });

  it("does not persist a monitor when public URL validation fails", async () => {
    const runtime = new ManualRuntime(Date.parse("2026-08-25T00:00:00.000Z"));
    const service = new PageMonitorService(
      new PageMonitorStore(":memory:", () => runtime.now()),
      { async readPageArtifact() { return artifact("hash"); } },
      {
        parse(raw: string) {
          return new URL(raw);
        },
        async assertPublic() {
          throw new ReadError("SSRF_BLOCKED", "private destination");
        },
      },
      true,
      runtime,
    );
    services.push(service);

    await expect(service.start({ url: "http://127.0.0.1/private" }, 60)).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
    expect(service.list()).toEqual([]);
  });
});

describe("PageMonitorStore recovery", () => {
  it("recovers an interrupted running monitor as immediately scheduled", () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-monitor-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "crawler.sqlite");
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    const first = new PageMonitorStore(path, () => now);
    const created = first.create({ url: "https://example.com/", browserAllowed: true }, 60);
    expect(first.claimDue()?.status).toBe("running");
    first.close();

    const reopened = new PageMonitorStore(path, () => now + 1_000);
    reopened.recoverInterrupted();
    expect(reopened.require(created.id)).toMatchObject({
      status: "scheduled",
      startedAt: null,
      nextRunAt: "2026-08-25T00:00:01.000Z",
    });
    reopened.close();
  });
});
