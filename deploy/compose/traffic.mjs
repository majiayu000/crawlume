// Steady end-to-end load for the Compose deployment: every interval, create a public read Job
// through the SDK, wait for it, download its cloud Artifact and verify the SHA-256. One JSON line per
// Job goes to stdout and /data/traffic.jsonl.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { CrawlumeClient } from "../dist/sdk/client.js";

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  return value;
};
const baseUrl = env("CRAWLUME_CONTROL_URL");
const apiKey = env("CRAWLUME_API_KEY");
const projectId = env("CRAWLUME_PROJECT_ID");
const target = env("CRAWLUME_TRAFFIC_TARGET");
const intervalMs = Number(env("CRAWLUME_TRAFFIC_INTERVAL_SECONDS")) * 1_000;
const client = new CrawlumeClient({ baseUrl, apiKey, projectId });

async function runOnce() {
  const startedAt = Date.now();
  const job = await client.createJob({
    type: "read",
    input: { url: target, browserAllowed: false, cacheMode: "live" },
    data_class: "public",
    placement: { class: "public", pinned_worker_id: null },
    required_capabilities: { http: true },
    budget: {
      deadline_ms: 120_000, max_provider_attempts: 3, max_document_bytes: 5_000_000,
      max_browser_ms: 0, max_browser_contexts: 0,
    },
    policy_version: "compose-traffic",
    upload_private_artifact: false,
  });
  const finished = await client.waitForJob(job.id, { timeoutMs: 180_000, intervalMs: 1_000 });
  const record = { time: new Date().toISOString(), jobId: job.id, status: finished.status,
    errorCode: finished.error_code, durationMs: 0, artifactVerified: false };
  if (finished.status === "completed") {
    for await (const publication of client.publications(job.id)) {
      if (publication.artifact.storage !== "cloud_object") continue;
      const download = await fetch(`${baseUrl}/projects/${projectId}/artifacts/${publication.artifact.id}/download`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (download.status !== 200) throw new Error(`download URL returned ${download.status}`);
      const { url } = await download.json();
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      const hash = createHash("sha256").update(bytes).digest("base64url");
      record.artifactVerified = hash === publication.artifact.content_hash;
    }
  }
  record.durationMs = Date.now() - startedAt;
  return record;
}

for (;;) {
  const started = Date.now();
  let record;
  try {
    record = await runOnce();
  } catch (error) {
    record = { time: new Date().toISOString(), status: "error", error: error instanceof Error ? error.message : String(error) };
  }
  const line = `${JSON.stringify(record)}\n`;
  process.stdout.write(line);
  appendFileSync("/data/traffic.jsonl", line);
  await delay(Math.max(0, intervalMs - (Date.now() - started)));
}
