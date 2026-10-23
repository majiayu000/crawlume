import { createServer } from "node:http";
import type { LookupAddress } from "node:dns";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WebhookDispatcher, WebhookSecretCipher } from "../src/control-plane/webhooks.js";
import type { ControlPlaneDatabase } from "../src/control-plane/project-scope.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { verifyWebhook } from "../src/sdk/webhooks.js";

const now = new Date("2026-10-24T00:00:00Z");
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const cipher = WebhookSecretCipher.fromKey(Buffer.alloc(32, 1));

function delivery(id = "delivery-1") {
  return {
    id,
    project_id: "project-1",
    attempt_count: 0,
    url: "https://webhook.invalid/events",
    endpoint_status: "active" as const,
    secret_ciphertext: cipher.encrypt(secret),
    previous_secret_ciphertext: null as Buffer | null,
    previous_secret_expires_at: null as Date | null,
    event_id: `event-${id}`,
    event_type: "job.completed" as const,
    payload: { job_id: "job-1", status: "completed" },
    occurred_at: now,
  };
}

function databaseFor(deliveries: ReturnType<typeof delivery>[]) {
  const attempts: (readonly unknown[])[] = [];
  const updates: (readonly unknown[])[] = [];
  const database: ControlPlaneDatabase = {
    async query<Row>() {
      return { rows: deliveries as unknown as Row[] };
    },
    async transaction(operation) {
      return operation({
        async query<Row>(statement: string, parameters: readonly unknown[]) {
          if (statement.includes("INSERT INTO webhook_delivery_attempts")) attempts.push(parameters);
          if (statement.includes("UPDATE webhook_deliveries")) updates.push(parameters);
          return { rows: [] as Row[] };
        },
      });
    },
  };
  return { database, attempts, updates };
}

function publicPolicy() {
  return new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("webhook delivery boundaries", () => {
  it("connects to the validated address while retaining the original Host and signature", async () => {
    const received: { host?: string; body?: string; headers?: Record<string, string> } = {};
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      received.host = request.headers.host!;
      received.body = body;
      received.headers = Object.fromEntries(Object.entries(request.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const row = delivery();
      row.url = `http://webhook.invalid:${address.port}/events`;
      // The trusted policy fixture permits only this local test listener. Production UrlPolicy
      // rejects loopback; the connection must use these returned addresses, not resolve .invalid.
      const assertPublic = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
      const state = databaseFor([row]);
      const dispatcher = new WebhookDispatcher(state.database, cipher, {
        parse: (input) => new URL(input), assertPublic,
      }, { now: () => now, timeoutMs: 1_000 });
      await expect(dispatcher.sweep()).resolves.toBe(1);
      expect(state.updates[0]?.[1]).toBe("succeeded");
      expect(assertPublic).toHaveBeenCalledTimes(1);
      expect(received.host).toBe(`webhook.invalid:${address.port}`);
      expect(received.body).toContain('"job_id":"job-1"');
      expect(verifyWebhook({
        secrets: secret, headers: received.headers!, body: received.body!, now: () => now.getTime(),
      })).toMatchObject({ id: "event-delivery-1" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("finishes a stalled DNS attempt and never sends after its late resolution", async () => {
    vi.useFakeTimers();
    let resolveDns!: (addresses: LookupAddress[]) => void;
    const policy = new UrlPolicy(() => new Promise((resolve) => { resolveDns = resolve; }));
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const state = databaseFor([delivery()]);
    const dispatcher = new WebhookDispatcher(state.database, cipher, policy, { fetch, timeoutMs: 50 });
    const sweep = dispatcher.sweep();
    await vi.advanceTimersByTimeAsync(50);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.[1]).toBe("pending");
    expect(state.attempts[0]?.[3]).toMatch(/timed out/i);
    await expect(sweep).resolves.toBe(1);
    resolveDns([{ address: "93.184.216.34", family: 4 }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.attempts).toHaveLength(1);
  });

  it("uses the same deadline for DNS and HTTP instead of restarting the timeout", async () => {
    vi.useFakeTimers();
    const policy = new UrlPolicy(() => new Promise((resolve) => {
      setTimeout(() => resolve([{ address: "93.184.216.34", family: 4 }]), 40);
    }));
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    });
    const state = databaseFor([delivery()]);
    const dispatcher = new WebhookDispatcher(state.database, cipher, policy, { fetch, timeoutMs: 50 });
    const sweep = dispatcher.sweep();
    await vi.advanceTimersByTimeAsync(40);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(state.updates).toHaveLength(1);
    expect(signal?.aborted).toBe(true);
    await expect(sweep).resolves.toBe(1);
  });

  it.each(["current", "previous"])("contains a corrupt %s secret without stopping healthy deliveries", async (which) => {
    const invalid = delivery("invalid");
    const corrupted = cipher.encrypt(secret);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    if (which === "current") invalid.secret_ciphertext = corrupted;
    else {
      invalid.previous_secret_ciphertext = corrupted;
      invalid.previous_secret_expires_at = new Date(now.getTime() + 60_000);
    }
    const state = databaseFor([invalid, delivery("healthy")]);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new WebhookDispatcher(state.database, cipher, publicPolicy(), {
      fetch, now: () => now, maxAttempts: 1,
    });
    await expect(dispatcher.sweep()).resolves.toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual(expect.arrayContaining([
      expect.arrayContaining(["invalid", "dead_letter"]),
      expect.arrayContaining(["healthy", "succeeded"]),
    ]));
    expect(state.attempts).toHaveLength(2);
  });

  it("still rejects private DNS answers without sending", async () => {
    const state = databaseFor([delivery()]);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const policy = new UrlPolicy(async () => [{ address: "127.0.0.1", family: 4 }]);
    await new WebhookDispatcher(state.database, cipher, policy, { fetch }).sweep();
    expect(fetch).not.toHaveBeenCalled();
    expect(state.updates[0]?.[1]).toBe("pending");
    expect(state.attempts[0]?.[3]).toMatch(/non-public/i);
  });

  it("continues to propagate database failures", async () => {
    const state = databaseFor([delivery()]);
    state.database.transaction = async () => { throw new Error("database unavailable"); };
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new WebhookDispatcher(state.database, cipher, publicPolicy(), { fetch });
    await expect(dispatcher.sweep()).rejects.toThrow("database unavailable");
  });
});
