import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { ReadError } from "../src/errors.js";
import { CrawlerMetrics } from "../src/metrics.js";
import { Telemetry, type ReadTelemetry } from "../src/telemetry.js";

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "crawlume-telemetry-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

function recordingFetch(status = 200) {
  const bodies: Array<{ api_key: string; batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }> }> = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init.body)));
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies, urls };
}

function telemetry(fetchImpl: typeof fetch, installIdPath = join(tempDir(), "telemetry-id")): Telemetry {
  return new Telemetry({ apiKey: "phc_test", host: "https://posthog.test/", installIdPath, version: "9.9.9" }, fetchImpl);
}

describe("telemetry", () => {
  it("is off unless enabled, and fails clearly without a project key", () => {
    vi.stubEnv("CRAWLUME_DATA_DIR", tempDir());
    expect(loadConfig().telemetry).toBeNull();
    vi.stubEnv("CRAWLUME_TELEMETRY", "1");
    expect(() => loadConfig()).toThrow(/CRAWLUME_TELEMETRY_KEY is required/u);
    vi.stubEnv("CRAWLUME_TELEMETRY_KEY", "phc_test");
    expect(loadConfig().telemetry).toMatchObject({ apiKey: "phc_test", host: "https://us.i.posthog.com" });
  });

  it("sends anonymous read events from recorded metrics without URLs or content", async () => {
    const { fetchImpl, bodies, urls } = recordingFetch();
    const sink = telemetry(fetchImpl);
    const metrics = new CrawlerMetrics(":memory:", undefined, (read) => sink.captureRead(read));
    metrics.recordFailure(
      new ReadError("SHELL_ONLY", "Shell at https://secret.example/path?token=1", {
        details: { finalUrl: "https://secret.example/path?token=1", attempts: 2 },
        execution: {
          planId: "plan_secret", plannerVersion: "p1", requestId: "r1",
          plannedStages: [{ stageId: "http-read", provider: "http", reasonCode: "HTTP_PRIMARY" }],
          executedStages: ["http-read"],
        } as never,
      }),
      120,
      "invalid",
    );
    metrics.close();
    await sink.close();

    expect(urls).toEqual(["https://posthog.test/batch/"]);
    const [event] = bodies[0]?.batch ?? [];
    expect(bodies[0]?.api_key).toBe("phc_test");
    expect(event).toMatchObject({
      event: "read_completed",
      properties: {
        $process_person_profile: false,
        outcome: "failure",
        error_code: "SHELL_ONLY",
        final_state: "invalid",
        executed_stages: ["http-read"],
        attempts: 2,
        crawlume_version: "9.9.9",
      },
    });
    expect(JSON.stringify(bodies)).not.toMatch(/secret|token|plan_secret/u);
  });

  it("keeps one install id across restarts and batches events", async () => {
    const path = join(tempDir(), "nested", "telemetry-id");
    const { fetchImpl, bodies } = recordingFetch();
    const read = { outcome: "success", errorCode: "", fetchMethod: "http" } as ReadTelemetry;
    const first = telemetry(fetchImpl, path);
    for (let index = 0; index < 21; index += 1) first.captureRead(read);
    await first.close();
    const second = telemetry(fetchImpl, path);
    second.captureRead(read);
    await second.close();

    expect(bodies.map((body) => body.batch.length)).toEqual([20, 1, 1]);
    const id = readFileSync(path, "utf8").trim();
    expect(new Set(bodies.flatMap((body) => body.batch.map((event) => event.distinct_id)))).toEqual(new Set([id]));
  });

  it("logs one warning and keeps working when uploads fail", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { fetchImpl } = recordingFetch(503);
    const sink = telemetry(fetchImpl);
    for (let index = 0; index < 40; index += 1) sink.captureRead({ outcome: "success" } as ReadTelemetry);
    await sink.close();

    const warnings = stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("telemetry_upload_failed"));
    expect(warnings).toHaveLength(1);
    stderr.mockRestore();
  });
});
