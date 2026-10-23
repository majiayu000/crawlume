import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadError } from "../src/errors.js";
import { RemoteWorkerHttpError, type RemoteWorkerClaim, type RemoteWorkerJob } from "../src/remote-worker/client.js";
import { createInMemoryWorkerIdentity } from "../src/remote-worker/enrollment.js";
import { RemoteWorkerOutbox } from "../src/remote-worker/outbox.js";
import { RemoteWorkerRunner, type RemoteWorkerRunnerOptions } from "../src/remote-worker/runner.js";
import type { ReadPageResult } from "../src/types.js";

const workerId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";

const claim = {
  requestId: "r",
  job: { id: jobId, type: "read", input: { url: "https://example.com/" } } as unknown as RemoteWorkerJob,
  lease: {
    id: leaseId, jobId, generation: 1,
    heartbeatDeadline: new Date(Date.now() + 30_000), leaseDeadline: new Date(Date.now() + 300_000),
  },
} as RemoteWorkerClaim;

const result = {
  status: "ok",
  sourceUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  fetchedAt: "2026-10-22T00:00:00.000Z",
  fetchMethod: "http",
  authProfile: null,
  title: "Example",
  byline: null,
  publishedTime: null,
  contentMarkdown: "Example body",
  contentHash: "hash",
  completeness: "complete",
  validation: { outcome: "valid", validatorVersion: "v1", checks: [], terminalError: null },
  evidence: { httpStatus: 200, contentType: "text/html", responseBytes: 512, contentCharacters: 12, attempts: 1 },
} as unknown as ReadPageResult;

function fakeClient(overrides: Partial<RemoteWorkerRunnerOptions["client"]> = {}) {
  return {
    createSession: vi.fn(async () => ({ requestId: "r", token: "a.b.c", expiresAt: new Date(Date.now() + 600_000) })),
    claim: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
    heartbeat: vi.fn(async () => ({ requestId: "r", lease: claim.lease })),
    appendEvent: vi.fn(async () => ({}) as never),
    publishResult: vi.fn(async () => ({}) as never),
    complete: vi.fn(async () => ({}) as never),
    uploadArtifact: vi.fn(async () => ({ uploadedAt: new Date() })),
    ...overrides,
  } satisfies RemoteWorkerRunnerOptions["client"];
}

function runner(
  client: RemoteWorkerRunnerOptions["client"],
  outbox: RemoteWorkerOutbox,
  execute: () => Promise<ReadPageResult>,
  cloudArtifacts = false,
) {
  return new RemoteWorkerRunner({
    client, outbox, identity: createInMemoryWorkerIdentity(), workerId,
    adapter: { execute: vi.fn(execute) }, claimWaitMs: 0, heartbeatIntervalMs: 60_000, cloudArtifacts,
  });
}

afterEach(() => vi.useRealTimers());

describe("RemoteWorkerRunner", () => {
  it("publishes a successful read and completes the lease", async () => {
    const outbox = new RemoteWorkerOutbox(":memory:");
    const client = fakeClient();
    await expect(runner(client, outbox, async () => result).runOnce(new AbortController().signal)).resolves.toBe("executed");
    expect(client.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "page.read", pageStatus: 200 }));
    expect(client.publishResult).toHaveBeenCalledWith(expect.objectContaining({ storage: "worker_local", completeness: "complete" }));
    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({
      leaseId, terminal: { status: "completed", resultCompleteness: "complete", errorCode: null },
    }));
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(outbox.getExecution({ jobId, leaseId, generation: 1 })?.state).toBe("terminal_acked");
    outbox.close();
  });

  it("uploads a cloud Artifact under the lease before committing the terminal", async () => {
    const outbox = new RemoteWorkerOutbox(":memory:");
    const order: string[] = [];
    const artifactId = "44444444-4444-4444-8444-444444444444";
    const publishResult = vi.fn(async (_options: Parameters<RemoteWorkerRunnerOptions["client"]["publishResult"]>[0]) => {
      order.push("publish");
      return { publication: { artifact: { id: artifactId } } } as never;
    });
    const client = fakeClient({
      publishResult,
      uploadArtifact: vi.fn(async () => {
        order.push("upload");
        return { uploadedAt: new Date() };
      }),
      complete: vi.fn(async () => {
        order.push("complete");
        return {} as never;
      }),
    });
    await runner(client, outbox, async () => result, true).runOnce(new AbortController().signal);
    expect(order).toEqual(["publish", "publish", "upload", "complete"]);
    expect(publishResult).toHaveBeenNthCalledWith(1, expect.objectContaining({ storage: "cloud_object" }));
    const { signal: _first, ...firstPublication } = publishResult.mock.calls[0]![0];
    expect(publishResult.mock.calls[1]?.[0]).toMatchObject(firstPublication);
    expect(client.uploadArtifact).toHaveBeenCalledWith(expect.objectContaining({ leaseId, generation: 1, artifactId }));
    outbox.close();
  });

  it("reports a reader failure as a failed terminal with its error code", async () => {
    const outbox = new RemoteWorkerOutbox(":memory:");
    const client = fakeClient();
    await runner(client, outbox, async () => {
      throw new ReadError("SSRF_BLOCKED", "blocked");
    }).runOnce(new AbortController().signal);
    expect(client.publishResult).not.toHaveBeenCalled();
    expect(client.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "page.failed", errorCode: "SSRF_BLOCKED" }));
    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({
      terminal: { status: "failed", resultCompleteness: null, errorCode: "SSRF_BLOCKED" },
    }));
    outbox.close();
  });

  it("blocks a fenced lease instead of retrying it forever", async () => {
    const outbox = new RemoteWorkerOutbox(":memory:");
    const client = fakeClient({
      appendEvent: vi.fn(async () => {
        throw new RemoteWorkerHttpError(409, "JOB_LEASE_FENCED", "r", false, null);
      }),
    });
    await expect(runner(client, outbox, async () => result).runOnce(new AbortController().signal)).resolves.toBe("executed");
    expect(client.complete).not.toHaveBeenCalled();
    expect(outbox.listRecoverableExecutions()).toEqual([]);
    outbox.close();
  });

  it("delivers a staged outcome left by a previous process before claiming new work", async () => {
    const outbox = new RemoteWorkerOutbox(":memory:");
    const first = fakeClient({
      publishResult: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    await expect(runner(first, outbox, async () => result).runOnce(new AbortController().signal)).rejects.toThrow("network down");
    expect(outbox.listRecoverableExecutions()).toHaveLength(1);

    const second = fakeClient({ claim: vi.fn(async () => null) });
    await expect(runner(second, outbox, async () => result).runOnce(new AbortController().signal)).resolves.toBe("idle");
    expect(second.appendEvent).not.toHaveBeenCalled();
    expect(second.publishResult).toHaveBeenCalledTimes(1);
    expect(second.complete).toHaveBeenCalledTimes(1);
    expect(outbox.listRecoverableExecutions()).toEqual([]);
    outbox.close();
  });

  it.each([false, true])("keeps the lease alive through slow upload and completion (recovery=%s)", async (recover) => {
    vi.useFakeTimers();
    const outbox = new RemoteWorkerOutbox(":memory:");
    const publication = { publication: { artifact: { id: "44444444-4444-4444-8444-444444444444" } } } as never;
    if (recover) {
      const first = fakeClient({
        publishResult: vi.fn(async () => publication),
        uploadArtifact: vi.fn(async () => { throw new Error("upload interrupted"); }),
      });
      await expect(runner(first, outbox, async () => result, true).runOnce(new AbortController().signal))
        .rejects.toThrow("upload interrupted");
    }
    let uploadDone!: () => void;
    let completeDone!: () => void;
    const upload = new Promise<void>((resolve) => { uploadDone = resolve; });
    const completion = new Promise<void>((resolve) => { completeDone = resolve; });
    let heartbeatDeadline = Date.now() + 90_000;
    const requireLiveLease = () => {
      if (Date.now() >= heartbeatDeadline) {
        throw new RemoteWorkerHttpError(409, "JOB_LEASE_FENCED", "r", false, null);
      }
    };
    const client = fakeClient({
      ...(recover ? { claim: vi.fn(async () => null) } : {}),
      publishResult: vi.fn(async () => publication),
      heartbeat: vi.fn(async () => {
        requireLiveLease();
        heartbeatDeadline = Date.now() + 90_000;
        return { requestId: "r", lease: claim.lease };
      }),
      uploadArtifact: vi.fn(async () => {
        await upload;
        requireLiveLease();
        return { uploadedAt: new Date() };
      }),
      complete: vi.fn(async () => {
        await completion;
        requireLiveLease();
        return {} as never;
      }),
    });
    const running = runner(client, outbox, async () => result, true).runOnce(new AbortController().signal);
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(client.uploadArtifact).toHaveBeenCalledTimes(1);
      expect(client.heartbeat).toHaveBeenCalledTimes(2);
      expect(client.complete).not.toHaveBeenCalled();
      uploadDone();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(client.complete).toHaveBeenCalledTimes(1);
      expect(client.heartbeat).toHaveBeenCalledTimes(4);
      completeDone();
      await expect(running).resolves.toBe(recover ? "idle" : "executed");
      expect(outbox.getExecution({ jobId, leaseId, generation: 1 })?.state).toBe("terminal_acked");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      uploadDone();
      completeDone();
      await running.catch(() => {});
      outbox.close();
    }
  });

  it("leaves completion retryable when session renewal fails before terminal dispatch", async () => {
    vi.useFakeTimers();
    const outbox = new RemoteWorkerOutbox(":memory:");
    const client = fakeClient({
      createSession: vi.fn()
        .mockResolvedValueOnce({ requestId: "r", token: "a.b.c", expiresAt: new Date(Date.now() + 600_000) })
        .mockRejectedValueOnce(new Error("session refresh failed"))
        .mockImplementation(async () => ({ requestId: "r", token: "a.b.c", expiresAt: new Date(Date.now() + 600_000) })),
      publishResult: vi.fn(async () => ({ publication: { artifact: { id: "44444444-4444-4444-8444-444444444444" } } }) as never),
      uploadArtifact: vi.fn(async () => ({ uploadedAt: new Date() }))
        .mockImplementationOnce(async () => {
          vi.setSystemTime(Date.now() + 600_000);
          return { uploadedAt: new Date() };
        }),
    });
    const worker = runner(client, outbox, async () => result, true);
    try {
      await expect(worker.runOnce(new AbortController().signal)).rejects.toThrow("session refresh failed");
      expect(client.complete).not.toHaveBeenCalled();
      expect(outbox.getExecution({ jobId, leaseId, generation: 1 })).toMatchObject({
        state: "staged", terminalAttemptedAtMs: null,
      });
      await worker.recoverStaged(new AbortController().signal);
      expect(client.complete).toHaveBeenCalledTimes(1);
      expect(outbox.getExecution({ jobId, leaseId, generation: 1 })?.state).toBe("terminal_acked");
    } finally {
      outbox.close();
    }
  });

  it("does not mark terminal attempted when cancelled before dispatch", async () => {
    const outbox = new RemoteWorkerOutbox(":memory:");
    const controller = new AbortController();
    const client = fakeClient({
      publishResult: vi.fn(async () => ({ publication: { artifact: { id: "44444444-4444-4444-8444-444444444444" } } }) as never),
      uploadArtifact: vi.fn(async () => {
        controller.abort(new Error("worker stopped"));
        return { uploadedAt: new Date() };
      }),
    });
    try {
      await expect(runner(client, outbox, async () => result, true).runOnce(controller.signal)).rejects.toThrow("worker stopped");
      expect(client.complete).not.toHaveBeenCalled();
      expect(outbox.getExecution({ jobId, leaseId, generation: 1 })).toMatchObject({
        state: "staged", terminalAttemptedAtMs: null,
      });
    } finally {
      outbox.close();
    }
  });

  it("keeps a retryable upload confirmation conflict staged for recovery", async () => {
    const outbox = new RemoteWorkerOutbox(":memory:");
    const failure = new RemoteWorkerHttpError(409, "ARTIFACT_UPLOAD_UNVERIFIED", "r", true, null);
    const client = fakeClient({
      publishResult: vi.fn(async () => ({ publication: { artifact: { id: "44444444-4444-4444-8444-444444444444" } } }) as never),
      uploadArtifact: vi.fn(async () => ({ uploadedAt: new Date() })).mockRejectedValueOnce(failure),
    });
    const worker = runner(client, outbox, async () => result, true);
    try {
      await expect(worker.runOnce(new AbortController().signal)).rejects.toBe(failure);
      expect(outbox.getExecution({ jobId, leaseId, generation: 1 })?.state).toBe("staged");
      await worker.recoverStaged(new AbortController().signal);
      expect(client.complete).toHaveBeenCalledTimes(1);
      expect(outbox.getExecution({ jobId, leaseId, generation: 1 })?.state).toBe("terminal_acked");
    } finally {
      outbox.close();
    }
  });
});
