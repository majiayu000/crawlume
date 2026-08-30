import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserFailureTraceStore } from "../src/browser-trace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function store(): Promise<{ root: string; traces: BrowserFailureTraceStore }> {
  const root = await mkdtemp(join(tmpdir(), "diaoyan-browser-trace-"));
  temporaryDirectories.push(root);
  return { root, traces: new BrowserFailureTraceStore(root) };
}

function failureInput(authorized = false) {
  return {
    authorized,
    phase: "readiness" as const,
    errorCode: "FETCH_TIMEOUT" as const,
    elapsedMs: 1_250,
    dom: Array.from({ length: 300 }, (_, index) => ({
      tag: index === 0 ? "script cookie=private-token" : "section",
      childElements: index,
      textCharacters: 99_999,
    })),
    network: {
      observedEvents: 50_000,
      failedRequests: 20,
      resourceTypes: { document: 1, script: 12, xhr: 8, other: 3 },
      statusClasses: { "2xx": 15, "3xx": 1, "4xx": 2, "5xx": 1, other: 0 },
    },
    console: { debug: 1, log: 2, info: 3, warning: 4, error: 5, other: 6 },
  };
}

describe("BrowserFailureTraceStore", () => {
  it("writes one bounded structural trace without URLs, messages, headers, or DOM text", async () => {
    const { traces } = await store();
    const traceRef = traces.record(failureInput());
    const trace = traces.read(traceRef);
    const serialized = JSON.stringify(trace);

    expect(traceRef).toMatch(/^browser-trace:[0-9a-f-]{36}$/u);
    expect(trace.dom).toHaveLength(256);
    expect(trace.dom?.[0]).toEqual({ tag: "unknown", childElements: 0, textCharacters: 99_999 });
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(32_768);
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toMatch(/cookie|authorization|https?:|console message/iu);
  });

  it("omits DOM entirely for an authorized profile", async () => {
    const { traces } = await store();
    const trace = traces.read(traces.record(failureInput(true)));

    expect(trace.authorized).toBe(true);
    expect(trace.dom).toBeNull();
  });

  it("retains at most 100 failure traces", async () => {
    const { root, traces } = await store();
    for (let index = 0; index < 101; index += 1) traces.record(failureInput(true));

    expect(await readdir(join(root, "traces"))).toHaveLength(100);
  });
});
