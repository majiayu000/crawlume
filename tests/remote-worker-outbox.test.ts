import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

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
  RemoteWorkerOutboxDeliveryActiveError,
  RemoteWorkerOutboxDedupeConflictError,
  RemoteWorkerOutboxIntegrityError,
  RemoteWorkerOutboxLeaseBlockedError,
  RemoteWorkerOutboxOwnershipError,
  RemoteWorkerOutboxPathError,
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

type ChildEntryMessage = Readonly<{
  type: "awaiting" | "state";
  entry: Readonly<{ state: string; localSequence: number }>;
}>;

function nextChildEntry(child: ChildProcess, type: ChildEntryMessage["type"]): Promise<ChildEntryMessage> {
  return new Promise((resolveMessage, rejectMessage) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message) || message.type !== type) return;
      cleanup();
      resolveMessage(message as ChildEntryMessage);
    };
    const onExit = (code: number | null) => {
      cleanup();
      rejectMessage(new Error(`child outbox owner exited before ${type}: ${String(code)}`));
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function startChildDelivery(path: string, baseUrl: string): Readonly<{
  child: ChildProcess;
  awaiting: Promise<ChildEntryMessage>;
}> {
  const outboxModuleUrl = pathToFileURL(resolve("src/remote-worker/outbox.ts")).href;
  const clientModuleUrl = pathToFileURL(resolve("src/remote-worker/client.ts")).href;
  const serializedEvent = JSON.stringify({
    ...eventInput(), occurredAt: eventInput().occurredAt.toISOString(),
  });
  const source = `
    import { RemoteWorkerOutbox } from ${JSON.stringify(outboxModuleUrl)};
    import { RemoteWorkerClient } from ${JSON.stringify(clientModuleUrl)};
    const lease = ${JSON.stringify(lease)};
    const event = ${serializedEvent};
    event.occurredAt = new Date(event.occurredAt);
    const outbox = new RemoteWorkerOutbox(${JSON.stringify(path)});
    outbox.enqueueEvent(lease, event);
    const report = (type) => process.send({ type, entry: outbox.listEntries(lease)[0] });
    process.on("message", (message) => { if (message === "inspect") report("state"); });
    const delivery = outbox.deliverNext({
      lease,
      sessionToken: ${JSON.stringify(sessionToken)},
      client: new RemoteWorkerClient(${JSON.stringify(baseUrl)}),
    });
    report("awaiting");
    await delivery;
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return { child, awaiting: nextChildEntry(child, "awaiting") };
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RemoteWorkerOutbox", () => {
  it("creates a private WAL database and atomically allocates independent Event/Publication sequences", () => {
    const path = outboxPath();
    const priorUmask = process.umask(0);
    let outbox: RemoteWorkerOutbox | undefined;
    try {
      outbox = new RemoteWorkerOutbox(path, () => 1_000);
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
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
      if (existsSync(`${path}-shm`)) expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
      outbox.close();
      outbox = undefined;
    } finally {
      outbox?.close();
      process.umask(priorUmask);
    }

    const database = new DatabaseSync(path);
    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rejects relative paths and existing shared parents without changing their mode", () => {
    expect(() => new RemoteWorkerOutbox("relative/outbox.sqlite"))
      .toThrow(RemoteWorkerOutboxPathError);
    const shared = mkdtempSync(join(tmpdir(), "remote-worker-shared-"));
    directories.push(shared);
    chmodSync(shared, 0o755);

    expect(() => new RemoteWorkerOutbox(join(shared, "outbox.sqlite")))
      .toThrow(RemoteWorkerOutboxPathError);
    expect(statSync(shared).mode & 0o777).toBe(0o755);

    const links = mkdtempSync(join(tmpdir(), "remote-worker-links-"));
    const privateTarget = mkdtempSync(join(tmpdir(), "remote-worker-private-"));
    directories.push(links, privateTarget);
    symlinkSync(privateTarget, join(links, "linked-private"), "dir");
    expect(() => new RemoteWorkerOutbox(join(links, "linked-private", "outbox.sqlite")))
      .toThrow(RemoteWorkerOutboxPathError);
  });

  it("allows only one live file owner and releases ownership on close", () => {
    const path = outboxPath();
    const first = new RemoteWorkerOutbox(path);
    expect(() => new RemoteWorkerOutbox(path)).toThrow(RemoteWorkerOutboxOwnershipError);
    expect(first.enqueueEvent(lease, eventInput())).toMatchObject({ state: "pending" });
    first.close();

    const reopened = new RemoteWorkerOutbox(path);
    expect(reopened.listEntries(lease)).toHaveLength(1);
    reopened.close();
  });

  it("keeps an inflight network delivery exclusively owned and replays it after process death", async () => {
    const path = outboxPath();
    const requestBodies: string[] = [];
    let markFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolveRequest) => { markFirstRequest = resolveRequest; });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        requestBodies.push(body);
        if (requestBodies.length === 1) {
          markFirstRequest();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(eventResponse()));
      });
    });
    await new Promise<void>((resolveListening) => { server.listen(0, "127.0.0.1", resolveListening); });
    const address = server.address() as AddressInfo;
    const { child, awaiting } = startChildDelivery(path, `http://127.0.0.1:${address.port}/v1/`);
    try {
      const [reported] = await Promise.all([awaiting, firstRequest]);
      expect(reported.entry).toMatchObject({ state: "inflight", localSequence: 1 });
      expect(() => new RemoteWorkerOutbox(path)).toThrow(RemoteWorkerOutboxOwnershipError);
      const afterOverlap = nextChildEntry(child, "state");
      child.send("inspect");
      await expect(afterOverlap).resolves.toMatchObject({
        entry: { state: "inflight", localSequence: 1 },
      });
      await killChild(child);

      const reopened = new RemoteWorkerOutbox(path);
      expect(reopened.listEntries(lease)).toEqual([
        expect.objectContaining({ state: "pending", localSequence: 1 }),
      ]);
      await expect(reopened.deliverNext({
        lease,
        sessionToken,
        client: new RemoteWorkerClient(`http://127.0.0.1:${address.port}/v1/`),
      })).resolves.toMatchObject({ state: "acked", localSequence: 1 });
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]).toBe(requestBodies[0]);
      expect(JSON.parse(requestBodies[1]!)).toMatchObject({ generation: 3, local_sequence: 1 });
      reopened.close();
    } finally {
      await killChild(child);
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => { if (error) rejectClose(error); else resolveClose(); });
      });
    }
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
    expect(outbox.listEntries(lease)[0]).toMatchObject({ state: "pending", ackedAtMs: null });

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
    expect(outbox.listEntries(lease)[0]).toMatchObject({ state: "acked", ackedAtMs: 2_000 });
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

  it("serializes same-generation delivery in id order without holding a transaction across the network", async () => {
    const path = outboxPath();
    const outbox = new RemoteWorkerOutbox(path);
    outbox.enqueueEvent(lease, eventInput());
    outbox.enqueueEvent(lease, eventInput(undefined, "page-2"));
    let releaseFirst!: (response: Response) => void;
    let releaseSecond!: (response: Response) => void;
    let markFirst!: () => void;
    let markSecond!: () => void;
    const firstResponse = new Promise<Response>((resolveResponse) => { releaseFirst = resolveResponse; });
    const secondResponse = new Promise<Response>((resolveResponse) => { releaseSecond = resolveResponse; });
    const firstReached = new Promise<void>((resolveReached) => { markFirst = resolveReached; });
    const secondReached = new Promise<void>((resolveReached) => { markSecond = resolveReached; });
    const dispatched: number[] = [];
    const remote = client((async (_input, init) => {
      const sequence = (JSON.parse(String(init?.body)) as { local_sequence: number }).local_sequence;
      dispatched.push(sequence);
      if (sequence === 1) { markFirst(); return firstResponse; }
      markSecond();
      return secondResponse;
    }) as typeof fetch);

    const first = outbox.deliverNext({ lease, sessionToken, client: remote });
    await firstReached;
    const second = outbox.deliverNext({ lease, sessionToken, client: remote });
    expect(() => outbox.close()).toThrow(RemoteWorkerOutboxDeliveryActiveError);
    expect(dispatched).toEqual([1]);
    expect(outbox.listEntries(lease).map(({ state }) => state)).toEqual(["inflight", "pending"]);
    expect(outbox.enqueueEvent(
      { jobId: otherJobId, leaseId: otherLeaseId, generation: 1 },
      eventInput(),
    )).toMatchObject({ state: "pending" });
    releaseFirst(jsonResponse(eventResponse(lease, 1)));
    await expect(first).resolves.toMatchObject({ state: "acked", localSequence: 1 });
    await secondReached;
    expect(dispatched).toEqual([1, 2]);
    releaseSecond(jsonResponse(eventResponse(lease, 2)));
    await expect(second).resolves.toMatchObject({ state: "acked", localSequence: 2 });
    outbox.close();
  });

  it("persists a heartbeat fence, blocks late success, and rejects new work after restart", async () => {
    const path = outboxPath();
    const outbox = new RemoteWorkerOutbox(path);
    outbox.enqueueEvent(lease, eventInput());
    outbox.enqueueEvent(lease, eventInput(undefined, "page-2"));
    let release!: (response: Response) => void;
    let dispatched!: () => void;
    const response = new Promise<Response>((resolveResponse) => { release = resolveResponse; });
    const reached = new Promise<void>((resolveReached) => { dispatched = resolveReached; });
    let networkCalls = 0;
    const remote = client((async () => {
      networkCalls += 1;
      dispatched();
      return response;
    }) as typeof fetch);
    const first = outbox.deliverNext({ lease, sessionToken, client: remote });
    await reached;
    const second = outbox.deliverNext({ lease, sessionToken, client: remote });
    outbox.blockLeaseGeneration(jobId, leaseId, 3, "JOB_LEASE_FENCED");
    expect(outbox.listEntries(lease).map(({ state }) => state)).toEqual(["blocked", "blocked"]);
    release(jsonResponse(eventResponse()));
    await expect(first).rejects.toMatchObject({ code: "JOB_LEASE_FENCED" });
    await expect(second).resolves.toBeNull();
    expect(networkCalls).toBe(1);
    outbox.close();

    const reopened = new RemoteWorkerOutbox(path);
    expect(() => reopened.enqueueEvent(lease, eventInput(undefined, "page-3")))
      .toThrow(RemoteWorkerOutboxLeaseBlockedError);
    expect(reopened.enqueueEvent(lease, eventInput())).toMatchObject({
      state: "blocked", blockedCode: "JOB_LEASE_FENCED", localSequence: 1,
    });
    reopened.close();
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
    expect(reopened.listEntries(lease)[0]).toMatchObject({ state: "pending" });
    await expect(reopened.deliverNext({
      lease,
      sessionToken,
      client: client((async () => jsonResponse({
        ...publicationResponse(),
        publication: { ...publicationResponse().publication, local_sequence: 2 },
      })) as typeof fetch),
    })).rejects.toBeInstanceOf(RemoteWorkerProtocolError);
    expect(reopened.listEntries(lease)[0]).toMatchObject({ state: "pending", ackedAtMs: null });
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

      expect(outbox.listEntries(lease)).toEqual(expect.arrayContaining([
        expect.objectContaining({ leaseId, state: "blocked", blockedCode: code }),
        expect.objectContaining({ leaseId, state: "blocked", blockedCode: code }),
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
      expect(outbox.listEntries(lease)[0]).toMatchObject({ state: "pending", blockedCode: null });
      outbox.close();
    }
  });

  it("detects payload tampering, stores no credentials, retains acknowledgements, and fails after close", async () => {
    const path = outboxPath();
    const initial = new RemoteWorkerOutbox(path);
    initial.enqueueEvent(lease, eventInput());
    initial.close();
    const database = new DatabaseSync(path);
    database.prepare("UPDATE remote_worker_outbox SET payload_json = replace(payload_json, '123', '124')")
      .run();
    database.close();

    const reopened = new RemoteWorkerOutbox(path);
    await expect(reopened.deliverNext({
      lease,
      sessionToken,
      client: client((async () => { throw new Error("must not send corrupt payload"); }) as typeof fetch),
    })).rejects.toBeInstanceOf(RemoteWorkerOutboxIntegrityError);
    reopened.close();
    expect(JSON.stringify(rows(path))).not.toContain(sessionToken);
    expect(JSON.stringify(rows(path))).not.toContain("private_key");
    expect(() => reopened.listPendingLeases()).toThrow(RemoteWorkerOutboxClosedError);
    expect(() => reopened.enqueueEvent(lease, eventInput())).toThrow(RemoteWorkerOutboxClosedError);
  });

  it("leaves the pre-enqueue crash window empty for control-plane lease recovery", () => {
    const path = outboxPath();
    const outbox = new RemoteWorkerOutbox(path);
    expect(outbox.listEntries(lease)).toEqual([]);
    expect(outbox.getEntry(lease, "event", "page-1")).toBeNull();
    outbox.close();
  });
});
