import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  RemoteWorkerClient,
  RemoteWorkerHttpError,
  RemoteWorkerProtocolError,
  RemoteWorkerTransportError,
} from "../src/remote-worker/client.js";
import {
  RemoteWorkerOutbox,
  RemoteWorkerOutboxClosedError,
  RemoteWorkerOutboxDedupeConflictError,
  RemoteWorkerOutboxIntegrityError,
  type RemoteWorkerOutboxLease,
} from "../src/remote-worker/outbox.js";

const jobId = "55555555-5555-4555-8555-555555555555";
const leaseId = "66666666-6666-4666-8666-666666666666";
const otherJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherLeaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestId = "44444444-4444-4444-8444-444444444444";
const eventId = "77777777-7777-4777-8777-777777777777";
const publicationId = "88888888-8888-4888-8888-888888888888";
const artifactId = "99999999-9999-4999-8999-999999999999";
const sessionToken = "aaa.bbb.ccc";
const contentHash = Buffer.alloc(32, 7).toString("base64url");
const lease = { jobId, leaseId, generation: 3 } as const;

const directories: string[] = [];

function outboxPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "remote-worker-outbox-"));
  directories.push(directory);
  return join(directory, "private", "outbox.sqlite");
}

function jsonResponse(body: unknown, status = 200, mediaType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": mediaType },
  });
}

function eventResponse(
  identity: RemoteWorkerOutboxLease = lease,
  localSequence = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    request_id: requestId,
    event: {
      id: eventId,
      job_id: identity.jobId,
      lease_id: identity.leaseId,
      lease_generation: identity.generation,
      local_sequence: localSequence,
      sequence: 1,
      event_type: "page.fetched",
      page_status: 200,
      error_code: null,
      provider: "http",
      byte_count: 123,
      duration_ms: 45,
      content_hash: contentHash,
      usage: { attempts: 1, bytes: 123 },
      occurred_at: "2026-09-03T01:00:10.000Z",
      recorded_at: "2026-09-03T01:00:11.000Z",
      ...overrides,
    },
  };
}

function publicationResponse(identity = lease, localSequence = 1) {
  return {
    request_id: requestId,
    publication: {
      id: publicationId,
      job_id: identity.jobId,
      lease_id: identity.leaseId,
      lease_generation: identity.generation,
      local_sequence: localSequence,
      sequence: 1,
      completeness: "complete",
      recorded_at: "2026-09-03T01:00:12.000Z",
      artifact: {
        id: artifactId,
        version: 1,
        content_hash: contentHash,
        byte_count: 123,
        media_type: "text/markdown",
        storage: "worker_local",
        object_key: null,
        created_at: "2026-09-03T01:00:12.000Z",
      },
    },
  };
}

function eventInput(
  usage: Record<string, number> = { bytes: 123, attempts: 1 },
  dedupeKey = "page-1",
) {
  return {
    dedupeKey,
    eventType: " page.fetched ",
    pageStatus: 200,
    errorCode: null,
    provider: " http ",
    byteCount: 123,
    durationMs: 45,
    contentHash,
    usage,
    occurredAt: new Date("2026-09-03T01:00:10.000Z"),
  } as const;
}

function publicationInput(dedupeKey = "result") {
  return {
    dedupeKey,
    contentHash,
    byteCount: 123,
    mediaType: " text/markdown ",
    completeness: "complete",
    storage: "worker_local",
  } as const;
}

function problem(code: string) {
  return {
    type: `https://api.diaoyan.example/errors/${code.toLowerCase()}`,
    title: "Submission rejected",
    status: 409,
    detail: "The submission was rejected.",
    instance: `/v1/job-leases/${leaseId}/events`,
    code,
    request_id: requestId,
    retryable: false,
  };
}

function client(fetcher: typeof fetch): RemoteWorkerClient {
  return new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });
}

function rows(path: string): Array<Record<string, unknown>> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(`
      SELECT job_id, lease_id, lease_generation, kind, dedupe_key, local_sequence,
        payload_json, hex(payload_hash) AS payload_hash, state, acked_at_ms, blocked_code
      FROM remote_worker_outbox ORDER BY id
    `).all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RemoteWorkerOutbox", () => {
  it("creates a private WAL database and atomically allocates independent Event/Publication sequences", () => {
    const path = outboxPath();
    const outbox = new RemoteWorkerOutbox(path, () => 1_000);

    expect(outbox.enqueueEvent(lease, eventInput())).toMatchObject({
      kind: "event", localSequence: 1, state: "pending", createdAtMs: 1_000,
    });
    expect(outbox.enqueueEvent(lease, eventInput(undefined, "page-2"))).toMatchObject({
      kind: "event", localSequence: 2,
    });
    expect(outbox.enqueuePublication(lease, publicationInput())).toMatchObject({
      kind: "publication", localSequence: 1,
    });
    expect(outbox.listPendingLeases()).toEqual([lease]);
    outbox.close();

    const database = new DatabaseSync(path);
    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("deduplicates stable logical submissions and exposes state without exposing payload", () => {
    const path = outboxPath();
    const outbox = new RemoteWorkerOutbox(path);
    const original = outbox.enqueuePublication(lease, publicationInput("final-result"));

    expect(outbox.enqueuePublication(lease, publicationInput(" final-result "))).toEqual(original);
    expect(outbox.getEntry(lease, "publication", "final-result")).toEqual(original);
    expect(outbox.listEntries(lease)).toEqual([original]);
    expect(outbox.listEntries(lease)[0]).not.toHaveProperty("payload");
    expect(outbox.listEntries(lease)[0]).not.toHaveProperty("payloadJson");
    expect(() => outbox.enqueuePublication(lease, {
      ...publicationInput("final-result"), byteCount: 124,
    })).toThrow(RemoteWorkerOutboxDedupeConflictError);
    expect(outbox.listEntries(lease)).toEqual([original]);
    outbox.close();
  });

  it("freezes canonical payload and replays identical bytes after a transport failure", async () => {
    const path = outboxPath();
    const usage = { bytes: 123, attempts: 1 };
    const outbox = new RemoteWorkerOutbox(path, () => 2_000);
    outbox.enqueueEvent(lease, eventInput(usage));
    usage.bytes = 999;
    usage.attempts = 9;
    const bodies: string[] = [];
    const failedClient = client((async (_input, init) => {
      bodies.push(String(init?.body));
      throw new Error(`network failed ${sessionToken}`);
    }) as typeof fetch);

    await expect(outbox.deliverNext({ lease, sessionToken, client: failedClient }))
      .rejects.toBeInstanceOf(RemoteWorkerTransportError);
    expect(rows(path)[0]).toMatchObject({ state: "pending", acked_at_ms: null });

    const replayClient = client((async (_input, init) => {
      bodies.push(String(init?.body));
      return jsonResponse(eventResponse());
    }) as typeof fetch);
    await expect(outbox.deliverNext({ lease, sessionToken, client: replayClient }))
      .resolves.toMatchObject({ state: "acked", localSequence: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      generation: 3,
      local_sequence: 1,
      usage: { attempts: 1, bytes: 123 },
    });
    expect(rows(path)[0]).toMatchObject({ state: "acked", acked_at_ms: 2_000 });
    expect(outbox.enqueueEvent(lease, eventInput())).toMatchObject({
      state: "acked", localSequence: 1, dedupeKey: "page-1",
    });
    expect(outbox.listEntries(lease)).toHaveLength(1);
    outbox.close();
    const reopened = new RemoteWorkerOutbox(path);
    await expect(reopened.deliverNext({
      lease,
      sessionToken,
      client: client((async () => { throw new Error("acknowledgement must be retained"); }) as typeof fetch),
    })).resolves.toBeNull();
    reopened.close();
  });

  it("commits inflight before the network call and never holds a SQLite transaction across it", async () => {
    const path = outboxPath();
    const outbox = new RemoteWorkerOutbox(path);
    outbox.enqueueEvent(lease, eventInput());
    let resolveResponse!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    let resolveDispatched!: () => void;
    const reachedFetch = new Promise<void>((resolve) => {
      resolveDispatched = resolve;
    });
    const delivery = outbox.deliverNext({
      lease,
      sessionToken,
      client: client((async () => {
        resolveDispatched();
        return waiting;
      }) as typeof fetch),
    });
    await reachedFetch;

    expect(rows(path)[0]).toMatchObject({ state: "inflight" });
    const concurrent = new DatabaseSync(path, { timeout: 0 });
    expect(() => concurrent.exec("BEGIN IMMEDIATE; ROLLBACK;")).not.toThrow();
    concurrent.close();
    resolveResponse(jsonResponse(eventResponse()));
    await expect(delivery).resolves.toMatchObject({ state: "acked" });
    outbox.close();
  });

  it("recovers inflight rows on process reopen and a malformed success never acknowledges", async () => {
    const path = outboxPath();
    const initial = new RemoteWorkerOutbox(path);
    initial.enqueuePublication(lease, publicationInput());
    initial.close();
    const database = new DatabaseSync(path);
    database.prepare("UPDATE remote_worker_outbox SET state = 'inflight'").run();
    database.close();

    const reopened = new RemoteWorkerOutbox(path);
    expect(rows(path)[0]).toMatchObject({ state: "pending" });
    await expect(reopened.deliverNext({
      lease,
      sessionToken,
      client: client((async () => jsonResponse({
        ...publicationResponse(),
        publication: { ...publicationResponse().publication, local_sequence: 2 },
      })) as typeof fetch),
    })).rejects.toBeInstanceOf(RemoteWorkerProtocolError);
    expect(rows(path)[0]).toMatchObject({ state: "pending", acked_at_ms: null });
    reopened.close();
  });

  it.each(["JOB_LEASE_FENCED", "JOB_RESULT_IDEMPOTENCY_CONFLICT"])(
    "blocks all unacked rows for only the exact fenced generation on %s",
    async (code) => {
      const path = outboxPath();
      const outbox = new RemoteWorkerOutbox(path);
      outbox.enqueueEvent(lease, eventInput());
      outbox.enqueuePublication(lease, publicationInput());
      const nextGeneration = { ...lease, generation: 4 };
      const otherLease = { jobId: otherJobId, leaseId: otherLeaseId, generation: 1 } as const;
      expect(() => outbox.enqueueEvent(nextGeneration, eventInput())).toThrow();
      outbox.enqueueEvent(otherLease, eventInput());

      await expect(outbox.deliverNext({
        lease,
        sessionToken,
        client: client((async () => jsonResponse(
          problem(code), 409, "application/problem+json",
        )) as typeof fetch),
      })).rejects.toMatchObject({ status: 409, code });

      expect(rows(path).slice(0, 2)).toEqual(expect.arrayContaining([
        expect.objectContaining({ lease_id: leaseId, state: "blocked", blocked_code: code }),
        expect.objectContaining({ lease_id: leaseId, state: "blocked", blocked_code: code }),
      ]));
      await expect(outbox.deliverNext({
        lease,
        sessionToken,
        client: client((async () => { throw new Error("must not send"); }) as typeof fetch),
      })).resolves.toBeNull();
      await expect(outbox.deliverNext({
        lease: otherLease,
        sessionToken,
        client: client((async () => jsonResponse(eventResponse(otherLease))) as typeof fetch),
      })).resolves.toMatchObject({ state: "acked", leaseId: otherLeaseId });
      outbox.close();
    },
  );

  it("keeps 401, 500, abort, and non-fencing HTTP failures pending and visible", async () => {
    const failures = [
      new RemoteWorkerHttpError(401, "WORKER_AUTHENTICATION_FAILED", requestId, false, null),
      new RemoteWorkerHttpError(500, "INTERNAL_ERROR", requestId, true, null),
      new RemoteWorkerHttpError(409, "OTHER_CONFLICT", requestId, false, null),
      new Error("aborted"),
    ];
    for (const failure of failures) {
      const path = outboxPath();
      const outbox = new RemoteWorkerOutbox(path);
      outbox.enqueueEvent(lease, eventInput());
      const fakeClient = {
        appendEvent: async () => { throw failure; },
        publishResult: async () => { throw new Error("unexpected publication"); },
      };
      await expect(outbox.deliverNext({ lease, sessionToken, client: fakeClient })).rejects.toBe(failure);
      expect(rows(path)[0]).toMatchObject({ state: "pending", blocked_code: null });
      outbox.close();
    }
  });

  it("detects payload tampering, stores no credentials, retains acknowledgements, and fails after close", async () => {
    const path = outboxPath();
    const outbox = new RemoteWorkerOutbox(path);
    outbox.enqueueEvent(lease, eventInput());
    const database = new DatabaseSync(path);
    database.prepare("UPDATE remote_worker_outbox SET payload_json = replace(payload_json, '123', '124')")
      .run();
    database.close();

    await expect(outbox.deliverNext({
      lease,
      sessionToken,
      client: client((async () => { throw new Error("must not send corrupt payload"); }) as typeof fetch),
    })).rejects.toBeInstanceOf(RemoteWorkerOutboxIntegrityError);
    expect(JSON.stringify(rows(path))).not.toContain(sessionToken);
    expect(JSON.stringify(rows(path))).not.toContain("private_key");
    outbox.close();
    expect(() => outbox.listPendingLeases()).toThrow(RemoteWorkerOutboxClosedError);
    expect(() => outbox.enqueueEvent(lease, eventInput())).toThrow(RemoteWorkerOutboxClosedError);
  });

  it("leaves the pre-enqueue crash window empty for control-plane lease recovery", () => {
    const path = outboxPath();
    const outbox = new RemoteWorkerOutbox(path);
    expect(outbox.listEntries(lease)).toEqual([]);
    expect(outbox.getEntry(lease, "event", "page-1")).toBeNull();
    outbox.close();
  });
});
