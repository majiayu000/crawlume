#!/usr/bin/env node

import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { logEvent } from "../log.js";
import { workerCapabilities } from "../remote-worker/capabilities.js";
import { RemoteWorkerClient } from "../remote-worker/client.js";
import { loadOrCreateWorkerIdentity, loadWorkerId, storeWorkerId } from "../remote-worker/identity-store.js";
import { RemoteWorkerOutbox } from "../remote-worker/outbox.js";
import { RemoteWorkerRunner } from "../remote-worker/runner.js";
import { PublicReadRuntimeAdapter } from "../remote-worker/runtime-adapter.js";

const usage = `Usage:
  crawlume-worker enroll [--control-url <https://host/v1>]
  crawlume-worker run [--control-url <https://host/v1>]

Environment:
  CRAWLUME_CONTROL_URL               Control-plane base URL ending in /v1
  CRAWLUME_WORKER_ENROLLMENT_TOKEN   One-time enrollment token (enroll only)
  CRAWLUME_WORKER_STATE_DIR          Worker key, ID and outbox (default: <data dir>/worker)
  CRAWLUME_WORKER_CLOUD_ARTIFACTS    1 uploads results to the control plane's object store
`;

const failureBackoffMs = 5_000;

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("package.json has no version.");
  return manifest.version;
}

function controlUrl(flag: string | undefined): string {
  const value = flag ?? process.env.CRAWLUME_CONTROL_URL;
  if (value === undefined || value === "") throw new Error("--control-url or CRAWLUME_CONTROL_URL is required.");
  return value;
}

function cloudArtifacts(): boolean {
  const value = process.env.CRAWLUME_WORKER_CLOUD_ARTIFACTS;
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error("CRAWLUME_WORKER_CLOUD_ARTIFACTS must be 0 or 1.");
}

function stateDirectory(): string {
  const directory = process.env.CRAWLUME_WORKER_STATE_DIR ?? join(loadConfig().dataDir, "worker");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function enroll(url: string): Promise<void> {
  const token = process.env.CRAWLUME_WORKER_ENROLLMENT_TOKEN;
  if (token === undefined || token === "") throw new Error("CRAWLUME_WORKER_ENROLLMENT_TOKEN is required.");
  const directory = stateDirectory();
  if (await loadWorkerId(directory) !== null) throw new Error(`A Worker is already enrolled in ${directory}.`);
  const { identity } = await loadOrCreateWorkerIdentity(directory);
  const enrolled = await new RemoteWorkerClient(url).enroll({
    enrollmentToken: token, identity, version: packageVersion(), capabilities: workerCapabilities(loadConfig()),
  });
  await storeWorkerId(directory, enrolled.worker.id);
  process.stdout.write(`${JSON.stringify({ worker_id: enrolled.worker.id, project_id: enrolled.worker.projectId })}\n`);
}

async function run(url: string): Promise<void> {
  const directory = stateDirectory();
  const workerId = await loadWorkerId(directory);
  if (workerId === null) throw new Error(`No Worker is enrolled in ${directory}; run crawlume-worker enroll first.`);
  const { identity } = await loadOrCreateWorkerIdentity(directory);
  const outbox = new RemoteWorkerOutbox(join(directory, "outbox.sqlite"));
  const app = createApp(loadConfig(), { runCrawlWorker: false });
  const stop = new AbortController();
  const shutdown = (): void => stop.abort(new Error("shutdown"));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const runner = new RemoteWorkerRunner({
    client: new RemoteWorkerClient(url), outbox, identity, workerId,
    adapter: new PublicReadRuntimeAdapter(app.reader),
    cloudArtifacts: cloudArtifacts(),
  });
  logEvent("info", "worker.started", { workerId });
  try {
    while (!stop.signal.aborted) {
      try {
        await runner.runOnce(stop.signal);
      } catch (error) {
        if (stop.signal.aborted) break;
        logEvent("error", "worker.iteration.failed", { error: error instanceof Error ? error.message : String(error) });
        await delay(failureBackoffMs, undefined, { signal: stop.signal }).catch(() => undefined);
      }
    }
  } finally {
    outbox.close();
    await app.close();
    logEvent("info", "worker.stopped", { workerId });
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  try {
    const { values } = parseArgs({ args: rest, options: { "control-url": { type: "string" } }, strict: true });
    if (command === "enroll") await enroll(controlUrl(values["control-url"]));
    else if (command === "run") await run(controlUrl(values["control-url"]));
    else throw new Error(`Unknown command: ${command}`);
    return 0;
  } catch (error) {
    logEvent("error", "worker.failed", { error: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}

const entry = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entry !== "" && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
