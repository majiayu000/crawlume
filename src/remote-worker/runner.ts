import { createHash } from "node:crypto";

import { normalizeError } from "../errors.js";
import { logEvent } from "../log.js";
import type { ReadPageResult } from "../types.js";
import {
  RemoteWorkerHttpError,
  type RemoteWorkerClaim,
  type RemoteWorkerClient,
  type RemoteWorkerSession,
} from "./client.js";
import type { InMemoryWorkerIdentity } from "./enrollment.js";
import type { RemoteWorkerOutbox, RemoteWorkerOutboxLease } from "./outbox.js";
import { encodePublicReadResultArtifact, publicReadResultMediaType } from "./read-result-artifact.js";
import type { PublicReadRuntimeAdapter } from "./runtime-adapter.js";

export type RemoteWorkerRunnerOptions = Readonly<{
  client: Pick<
    RemoteWorkerClient,
    "createSession" | "claim" | "heartbeat" | "appendEvent" | "publishResult" | "complete" | "uploadArtifact"
  >;
  outbox: RemoteWorkerOutbox;
  identity: InMemoryWorkerIdentity;
  workerId: string;
  adapter: Pick<PublicReadRuntimeAdapter, "execute">;
  /** Store public read results in the control plane's object store instead of on this Worker. */
  cloudArtifacts?: boolean;
  claimWaitMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => number;
}>;

export type RemoteWorkerIteration = "idle" | "executed";

const sessionRefreshMarginMs = 60_000;
// The publication dedupe key records the storage choice so a restarted Worker uploads the same way.
const localPublicationKey = "read";
const cloudPublicationKey = "read:cloud";

function leaseOf(claim: RemoteWorkerClaim): RemoteWorkerOutboxLease {
  return { jobId: claim.job.id, leaseId: claim.lease.id, generation: claim.lease.generation };
}

/**
 * Claims one public read Job at a time, runs it through the Reader, stages the outcome in the
 * durable outbox, delivers the event and publication, then commits the terminal state. A staged
 * outcome survives restarts and is delivered by recoverStaged() before new work is claimed.
 */
export class RemoteWorkerRunner {
  private session: RemoteWorkerSession | null = null;
  private readonly now: () => number;

  constructor(private readonly options: RemoteWorkerRunnerOptions) {
    this.now = options.now ?? Date.now;
  }

  async runOnce(signal: AbortSignal): Promise<RemoteWorkerIteration> {
    await this.recoverStaged(signal);
    const claim = await this.options.client.claim({
      workerId: this.options.workerId,
      sessionToken: await this.sessionToken(signal),
      waitMs: this.options.claimWaitMs ?? 20_000,
      signal,
    });
    if (claim === null) return "idle";
    logEvent("info", "worker.job.claimed", { jobId: claim.job.id, leaseId: claim.lease.id });
    const lease = leaseOf(claim);
    const execution = new AbortController();
    const abort = (): void => execution.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const heartbeat = this.startHeartbeat(lease, execution);
    try {
      const startedAt = this.now();
      let result: ReadPageResult | null = null;
      let failure: ReturnType<typeof normalizeError> | null = null;
      try {
        result = await this.options.adapter.execute(claim.job, execution.signal);
      } catch (error) {
        if (signal.aborted) throw error;
        failure = normalizeError(error);
      }
      execution.signal.throwIfAborted();
      this.stage(lease, result, failure, this.now() - startedAt);
      await this.deliverAndComplete(lease, execution.signal);
    } finally {
      clearInterval(heartbeat);
      execution.abort();
      signal.removeEventListener("abort", abort);
    }
    return "executed";
  }

  /** Delivers staged outcomes left by an earlier process; terminal outcomes already attempted are reported. */
  async recoverStaged(signal: AbortSignal): Promise<void> {
    for (const execution of this.options.outbox.listRecoverableExecutions()) {
      const lease = { jobId: execution.jobId, leaseId: execution.leaseId, generation: execution.generation };
      if (execution.state === "terminal_attempted") {
        logEvent("warn", "worker.terminal.outcome_unknown", lease);
        continue;
      }
      const delivery = new AbortController();
      const abort = (): void => delivery.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const heartbeat = this.startHeartbeat(lease, delivery);
      try {
        await this.deliverAndComplete(lease, delivery.signal);
      } finally {
        clearInterval(heartbeat);
        delivery.abort();
        signal.removeEventListener("abort", abort);
      }
    }
  }

  private stage(
    lease: RemoteWorkerOutboxLease,
    result: ReadPageResult | null,
    failure: ReturnType<typeof normalizeError> | null,
    durationMs: number,
  ): void {
    const occurredAt = new Date(this.now());
    if (result !== null) {
      const artifact = encodePublicReadResultArtifact(result);
      const cloud = this.options.cloudArtifacts === true;
      this.options.outbox.stageOutcome(lease, {
        outcome: "success",
        event: {
          dedupeKey: "read", eventType: "page.read", pageStatus: result.evidence.httpStatus,
          errorCode: null, provider: result.fetchMethod, byteCount: result.evidence.responseBytes,
          durationMs, contentHash: artifact.contentHash, usage: { attempts: result.evidence.attempts ?? 1 },
          occurredAt,
        },
        publication: {
          dedupeKey: cloud ? cloudPublicationKey : localPublicationKey, contentHash: artifact.contentHash,
          byteCount: artifact.byteCount, mediaType: artifact.mediaType, completeness: artifact.completeness,
          storage: cloud ? "cloud_object" : artifact.storage,
        },
        artifactBytes: new Uint8Array(artifact.bytes),
        terminal: { status: "completed", resultCompleteness: artifact.completeness, errorCode: null },
      });
      return;
    }
    const code = failure?.code ?? "INTERNAL_ERROR";
    this.options.outbox.stageOutcome(lease, {
      outcome: "failure",
      event: {
        dedupeKey: "read", eventType: "page.failed", pageStatus: null, errorCode: code, provider: null,
        byteCount: 0, durationMs, contentHash: null, usage: {}, occurredAt,
      },
      terminal: { status: "failed", resultCompleteness: null, errorCode: code },
    });
  }

  private async deliverAndComplete(lease: RemoteWorkerOutboxLease, signal: AbortSignal): Promise<void> {
    try {
      while (await this.options.outbox.deliverNext({
        lease, sessionToken: await this.sessionToken(signal), client: this.options.client, signal,
      }) !== null);
      await this.uploadCloudArtifact(lease, signal);
      const sessionToken = await this.sessionToken(signal);
      signal.throwIfAborted();
      const start = this.options.outbox.beginTerminal(lease);
      await this.options.client.complete({
        sessionToken, leaseId: lease.leaseId,
        expectedJobId: lease.jobId, generation: lease.generation, terminal: start.terminal, signal,
      });
      this.options.outbox.ackTerminal(start.attempt);
      logEvent("info", "worker.job.completed", { ...lease, status: start.terminal.status });
    } catch (error) {
      if (error instanceof RemoteWorkerHttpError && error.status === 409 && error.code === "JOB_LEASE_FENCED") {
        // The lease was fenced; the control plane re-queues the Job under a new generation.
        this.options.outbox.blockLeaseGeneration(lease.jobId, lease.leaseId, lease.generation, error.code);
        logEvent("warn", "worker.lease.fenced", { ...lease, code: error.code });
        return;
      }
      throw error;
    }
  }

  /**
   * Replays the acknowledged publication (idempotent on the server) to learn its Artifact ID, then
   * uploads the staged bytes. Runs before the terminal so completed Jobs have downloadable results.
   */
  private async uploadCloudArtifact(lease: RemoteWorkerOutboxLease, signal: AbortSignal): Promise<void> {
    const execution = this.options.outbox.getExecution(lease);
    if (execution?.publication?.dedupeKey !== cloudPublicationKey || execution.artifactBytes === null ||
        execution.terminal?.status !== "completed") {
      return;
    }
    const sessionToken = await this.sessionToken(signal);
    const published = await this.options.client.publishResult({
      sessionToken, leaseId: lease.leaseId, expectedJobId: lease.jobId, generation: lease.generation,
      localSequence: execution.publication.localSequence,
      contentHash: createHash("sha256").update(execution.artifactBytes).digest("base64url"),
      byteCount: execution.artifactBytes.byteLength, mediaType: publicReadResultMediaType,
      completeness: execution.terminal.resultCompleteness, storage: "cloud_object", signal,
    });
    await this.options.client.uploadArtifact({
      sessionToken, leaseId: lease.leaseId, generation: lease.generation,
      artifactId: published.publication.artifact.id, bytes: execution.artifactBytes, signal,
    });
    logEvent("info", "worker.artifact.uploaded", { ...lease, artifactId: published.publication.artifact.id });
  }

  private startHeartbeat(lease: RemoteWorkerOutboxLease, execution: AbortController): ReturnType<typeof setInterval> {
    return setInterval(() => {
      void (async () => {
        try {
          await this.options.client.heartbeat({
            sessionToken: await this.sessionToken(execution.signal),
            leaseId: lease.leaseId,
            generation: lease.generation,
            signal: execution.signal,
          });
        } catch (error) {
          if (execution.signal.aborted) return;
          logEvent("warn", "worker.heartbeat.failed", {
            leaseId: lease.leaseId, error: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof RemoteWorkerHttpError && error.status === 409 && error.code === "JOB_LEASE_FENCED") {
            execution.abort(error);
          }
        }
      })();
    }, this.options.heartbeatIntervalMs ?? 10_000);
  }

  private async sessionToken(signal: AbortSignal): Promise<string> {
    if (this.session === null || this.session.expiresAt.getTime() - sessionRefreshMarginMs <= this.now()) {
      this.session = await this.options.client.createSession({
        workerId: this.options.workerId, identity: this.options.identity, signal,
      });
    }
    return this.session.token;
  }
}
