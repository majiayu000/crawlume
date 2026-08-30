import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttemptLedger } from "../src/jobs.js";
import type { AttemptInput } from "../src/types.js";

const ledgers: AttemptLedger[] = [];
const directories: string[] = [];

function attempt(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    requestId: "request-1",
    planId: "plan-1",
    stageId: "http-1",
    provider: "http",
    providerVersion: "undici-8.10.0",
    outcome: "succeeded",
    rawRef: "sha256:raw",
    traceRef: null,
    errorCode: null,
    usage: {
      documentBytesIn: 1_000,
      networkBytesOut: 200,
      browserMilliseconds: 0,
      browserContextStarts: 0,
      retryDelayMilliseconds: 0,
      optionalModelTokens: 0,
    },
    startedAt: "2026-08-29T01:00:00.000Z",
    completedAt: "2026-08-29T01:00:00.100Z",
    ...overrides,
  };
}

afterEach(() => {
  while (ledgers.length > 0) ledgers.pop()?.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("AttemptLedger", () => {
  it("appends immutable attempts in per-request sequence order and replays them", () => {
    let now = Date.parse("2026-08-29T01:00:01.000Z");
    const ledger = new AttemptLedger(":memory:", () => now);
    ledgers.push(ledger);

    const first = ledger.append(attempt());
    now += 1_000;
    const second = ledger.append(attempt({
      stageId: "browser-1",
      provider: "browser",
      providerVersion: "playwright-1.62.1",
      usage: {
        ...attempt().usage,
        documentBytesIn: 2_000,
        browserMilliseconds: 700,
        browserContextStarts: 1,
      },
    }));

    expect(first).toMatchObject({ sequence: 1, recordedAt: "2026-08-29T01:00:01.000Z" });
    expect(second).toMatchObject({ sequence: 2, recordedAt: "2026-08-29T01:00:02.000Z" });
    expect(ledger.list("request-1")).toEqual([first, second]);
  });

  it("projects current state and cumulative resource usage without mutating attempts", () => {
    const ledger = new AttemptLedger(":memory:");
    ledgers.push(ledger);
    ledger.append(attempt({ outcome: "failed", rawRef: null, errorCode: "UPSTREAM_ERROR" }));
    ledger.append(attempt({
      stageId: "browser-1",
      provider: "browser",
      providerVersion: "playwright-1.62.1",
      outcome: "succeeded",
      usage: {
        documentBytesIn: 2_000,
        networkBytesOut: 100,
        browserMilliseconds: 600,
        browserContextStarts: 1,
        retryDelayMilliseconds: 50,
        optionalModelTokens: 0,
      },
    }));

    expect(ledger.project("request-1")).toEqual({
      requestId: "request-1",
      attempts: 2,
      lastSequence: 2,
      lastOutcome: "succeeded",
      lastStageId: "browser-1",
      usage: {
        documentBytesIn: 3_000,
        networkBytesOut: 300,
        browserMilliseconds: 600,
        browserContextStarts: 1,
        retryDelayMilliseconds: 50,
        optionalModelTokens: 0,
      },
    });
    expect(ledger.project("missing")).toBeNull();
  });

  it("persists append-only evidence across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-attempt-ledger-"));
    directories.push(directory);
    const path = join(directory, "ledger.sqlite");
    const first = new AttemptLedger(path);
    first.append(attempt());
    first.close();

    const reopened = new AttemptLedger(path);
    ledgers.push(reopened);
    expect(reopened.list("request-1")).toHaveLength(1);
    expect(reopened.append(attempt({ stageId: "validate-1", provider: "adapter" })))
      .toMatchObject({ sequence: 2 });
  });

  it("rejects malformed time, usage, and outcome evidence clearly", () => {
    const ledger = new AttemptLedger(":memory:");
    ledgers.push(ledger);
    expect(() => ledger.append(attempt({
      completedAt: "2026-08-29T00:59:59.000Z",
    }))).toThrow("completedAt");
    expect(() => ledger.append(attempt({
      usage: { ...attempt().usage, documentBytesIn: -1 },
    }))).toThrow("documentBytesIn");
    expect(() => ledger.append(attempt({
      outcome: "succeeded",
      errorCode: "UPSTREAM_ERROR",
    }))).toThrow("successful attempts cannot have errorCode");
    expect(() => ledger.append(attempt({
      outcome: "failed",
      errorCode: null,
    }))).toThrow("failed attempts require errorCode");
  });
});
