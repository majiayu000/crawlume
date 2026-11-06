import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { logEvent } from "./log.js";

export type TelemetryConfig = {
  apiKey: string;
  host: string;
  installIdPath: string;
  version: string;
};

/** One finished read. It never carries a URL, a host, page content, or a plan identifier. */
export type ReadTelemetry = {
  outcome: "success" | "failure";
  errorCode: string;
  fetchMethod: string;
  cacheStatus: string;
  finalState: string;
  plannerVersion: string;
  extractorVersion: string;
  validatorVersion: string;
  executedStages: string[];
  attempts: number;
  contentCharacters: number;
  durationMs: number;
};

const flushBatchSize = 20;
const flushIntervalMs = 60_000;
const closeTimeoutMs = 3_000;

function installId(path: string): string {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

/**
 * Opt-in anonymous read statistics sent to PostHog in batches. Delivery is best effort: a failed
 * upload is logged once to stderr and dropped, because reads must never depend on it.
 */
export class Telemetry {
  private readonly distinctId: string;
  private queue: Array<Record<string, unknown>> = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly timer: NodeJS.Timeout;
  private warned = false;

  constructor(
    private readonly config: TelemetryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.distinctId = installId(config.installIdPath);
    this.timer = setInterval(() => this.flush(), flushIntervalMs);
    this.timer.unref();
  }

  captureRead(read: ReadTelemetry): void {
    this.queue.push({
      event: "read_completed",
      distinct_id: this.distinctId,
      timestamp: new Date().toISOString(),
      properties: {
        $process_person_profile: false,
        $geoip_disable: true,
        outcome: read.outcome,
        error_code: read.errorCode,
        fetch_method: read.fetchMethod,
        cache_status: read.cacheStatus,
        final_state: read.finalState,
        planner_version: read.plannerVersion,
        extractor_version: read.extractorVersion,
        validator_version: read.validatorVersion,
        executed_stages: read.executedStages,
        attempts: read.attempts,
        content_characters: read.contentCharacters,
        duration_ms: read.durationMs,
        crawlume_version: this.config.version,
        node_version: process.version,
        os: process.platform,
        arch: process.arch,
      },
    });
    if (this.queue.length >= flushBatchSize) this.flush();
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const request = this.fetchImpl(`${this.config.host.replace(/\/$/u, "")}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: this.config.apiKey, batch }),
      signal: AbortSignal.timeout(closeTimeoutMs),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch((error: unknown) => {
      if (this.warned) return;
      this.warned = true;
      logEvent("warn", "telemetry_upload_failed", { events: batch.length, error: String(error) });
    }).finally(() => {
      this.inflight.delete(request);
    });
    this.inflight.add(request);
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.flush();
    await Promise.all(this.inflight);
  }
}
