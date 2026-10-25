// One-time bootstrap for the Compose deployment: logs in through the test identity provider,
// creates the Project, an API key and a Worker enrollment token, and creates the artifact bucket.
// Writes /secrets/project.env (0600). Run: docker compose run --rm bootstrap
import { writeFileSync } from "node:fs";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

const control = "https://127.0.0.1:8787/v1";

async function json(response, expected) {
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(`${response.url} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function login() {
  const begin = await fetch(`${control}/auth/oidc/begin`, { redirect: "manual" });
  if (begin.status !== 302) throw new Error(`OIDC begin returned ${begin.status}`);
  const stateCookie = begin.headers.getSetCookie()[0]?.split(";", 1)[0];
  const authorize = await fetch(begin.headers.get("location"), { redirect: "manual" });
  if (authorize.status !== 302) throw new Error(`Identity provider returned ${authorize.status}`);
  const callback = new URL(authorize.headers.get("location"));
  const query = new URLSearchParams({
    state: callback.searchParams.get("state"),
    code: callback.searchParams.get("code"),
  });
  const session = await json(
    await fetch(`${control}/auth/oidc/callback?${query}`, { headers: { cookie: stateCookie } }),
    200,
  );
  return { authorization: `Bearer ${session.access_token}` };
}

const human = await login();
const { organizations } = await json(await fetch(`${control}/organizations`, { headers: human }), 200);
const organizationId = organizations[0].id;
const { project } = await json(await fetch(`${control}/organizations/${organizationId}/projects`, {
  method: "POST",
  headers: { ...human, "content-type": "application/json", "idempotency-key": "compose-project" },
  body: JSON.stringify({ slug: "staging", name: "Staging" }),
}), 201);
const apiKey = await json(await fetch(`${control}/projects/${project.id}/api-keys`, {
  method: "POST",
  headers: { ...human, "content-type": "application/json" },
  body: JSON.stringify({ scopes: ["tasks:write", "results:read", "project:admin"], expires_at: null }),
}), 201);
const enrollment = await json(await fetch(`${control}/projects/${project.id}/worker-enrollments`, {
  method: "POST",
  headers: { ...human, "content-type": "application/json" },
  body: JSON.stringify({ worker_name: "compose-worker" }),
}), 201);

await new S3Client({ region: "us-east-1", endpoint: "http://127.0.0.1:4566", forcePathStyle: true })
  .send(new CreateBucketCommand({ Bucket: "crawlume-artifacts" }))
  .catch((error) => {
    if (error?.name !== "BucketAlreadyOwnedByYou") throw error;
  });

writeFileSync("/secrets/project.env", [
  `CRAWLUME_PROJECT_ID=${project.id}`,
  `CRAWLUME_API_KEY=${apiKey.secret}`,
  `CRAWLUME_WORKER_ENROLLMENT_TOKEN=${enrollment.enrollment_token}`,
  "",
].join("\n"), { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ organizationId, projectId: project.id, apiKeyId: apiKey.api_key.id })}\n`);
