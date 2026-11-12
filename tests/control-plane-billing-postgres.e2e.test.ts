import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { parseBillingPriceTable } from "../src/control-plane/billing.js";
import { ReaderService } from "../src/reader.js";
import { RemoteWorkerClient } from "../src/remote-worker/client.js";
import { InMemoryWorkerIdentity } from "../src/remote-worker/enrollment.js";
import { RemoteWorkerOutbox } from "../src/remote-worker/outbox.js";
import { RemoteWorkerRunner } from "../src/remote-worker/runner.js";
import { PublicReadRuntimeAdapter } from "../src/remote-worker/runtime-adapter.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { startControlPlaneRuntime, type ControlPlaneRuntime } from "../src/server.js";
import { publicResolver, rawPage, StubFetcher, testConfig } from "./helpers.js";

// Runs the real control-plane runtime on a loopback socket: credits are refused at zero balance,
// bought through a (recorded) Stripe Checkout + signed webhook, then metered by a real Worker run.

const configuredDatabaseUrl = process.env.DIAOYAN_TEST_POSTGRES_URL;
const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;
const webhookSecret = "whsec_e2ebilling";
const issuer = "https://identity.billing.example";
const tokenEndpoint = `${issuer}/token`;
const clientId = "billing-e2e";

function databaseUrl(name: string): string {
  if (configuredDatabaseUrl === undefined) throw new Error("DIAOYAN_TEST_POSTGRES_URL is required.");
  const url = new URL(configuredDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function quotedTestDatabase(name: string): string {
  if (!/^diaoyan_billing_test_[0-9a-f]{32}$/u.test(name)) {
    throw new Error(`Refusing to use an unexpected PostgreSQL test database name: ${name}`);
  }
  return `"${name}"`;
}

describeWithPostgres("control-plane billing end to end", () => {
  const databaseName = `diaoyan_billing_test_${randomUUID().replaceAll("-", "")}`;
  let administrator: Pool | undefined;
  let runtime: ControlPlaneRuntime | undefined;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    administrator = new Pool({ connectionString: configuredDatabaseUrl, max: 1 });
    await administrator.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await runtime?.close();
    await administrator?.query(`DROP DATABASE IF EXISTS ${quotedTestDatabase(databaseName)}`);
    await administrator?.end();
  });

  it("refuses work at zero balance, credits a paid checkout, and meters a completed read", async () => {
    const providerKeys = await generateKeyPair("EdDSA");
    const humanKeys = await generateKeyPair("EdDSA");
    const sessionKeys = await generateKeyPair("EdDSA");
    let nonce: string | null = null;
    const stripeRequests: URLSearchParams[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api.stripe.com/v1/checkout/sessions") {
        stripeRequests.push(new URLSearchParams(String(init?.body ?? "")));
        return new Response(JSON.stringify({
          id: "cs_test_e2e", object: "checkout.session",
          url: "https://checkout.stripe.com/c/pay/cs_test_e2e",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url !== tokenEndpoint || nonce === null) throw new Error(`Unexpected fetch: ${url}`);
      const issuedAt = Math.floor(Date.now() / 1_000);
      const idToken = await new SignJWT({ nonce, email: "billing@example.test", name: "Billing" })
        .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
        .setIssuer(issuer).setAudience(clientId).setSubject("billing-subject")
        .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 300)
        .sign(providerKeys.privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };

    runtime = await startControlPlaneRuntime({
      database: { connectionString: databaseUrl(databaseName), max: 4 },
      humanIdentity: {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint,
        clientId,
        redirectUri: "https://app.billing.example/v1/auth/oidc/callback",
        idTokenAlgorithms: ["EdDSA"],
        idTokenVerificationKey: providerKeys.publicKey,
        accessTokenIssuer: "https://control.billing.example",
        accessTokenAudience: "billing-human",
        accessTokenPrivateKey: humanKeys.privateKey,
        accessTokenPublicKey: humanKeys.publicKey,
      },
      identity: {
        sessionTokenIssuer: "https://control.billing.example",
        sessionTokenAudience: "billing-worker",
        sessionTokenPrivateKey: sessionKeys.privateKey,
        sessionTokenPublicKey: sessionKeys.publicKey,
      },
      listener: { host: "127.0.0.1", port: 0, tls: null },
      billingPrices: parseBillingPriceTable({
        currency: "usd",
        meters: { page_read: 2, browser_read: 10, crawl_page: 1, search_query: 5 },
        credit_packs: [{ id: "starter", name: "Starter credits", credits: 100, amount: 500 }],
      }),
      stripe: {
        secretKey: "sk_test_e2e",
        webhookSecret,
        successUrl: "https://app.billing.example/billing/success",
        cancelUrl: "https://app.billing.example/billing/cancel",
      },
    });
    const origin = runtime.origin;
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await originalFetch(`${origin}${path}`, init);
      const text = await response.text();
      return { status: response.status, body: text === "" ? null : JSON.parse(text) as any };
    };

    // Human login through the OIDC callback, then Project, API Key and Worker provisioning.
    const begin = await originalFetch(`${origin}/v1/auth/oidc/begin`, { redirect: "manual" });
    const authorization = new URL(begin.headers.get("location") ?? "");
    nonce = authorization.searchParams.get("nonce");
    const callback = await call(
      `/v1/auth/oidc/callback?state=${authorization.searchParams.get("state")}&code=billing-code`,
      { headers: { cookie: begin.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "" } },
    );
    expect(callback.status).toBe(200);
    const human = { authorization: `Bearer ${callback.body.access_token}` };
    const json = { ...human, "content-type": "application/json" };
    const organizationId = (await call("/v1/organizations", { headers: human }))
      .body.organizations[0].id as string;
    const project = await call(`/v1/organizations/${organizationId}/projects`, {
      method: "POST", headers: { ...json, "idempotency-key": "billing-project" },
      body: JSON.stringify({ slug: "billing", name: "Billing" }),
    });
    const projectId = project.body.project.id as string;
    const apiKey = await call(`/v1/projects/${projectId}/api-keys`, {
      method: "POST", headers: json,
      body: JSON.stringify({ scopes: ["tasks:write", "results:read"], expires_at: null }),
    });
    const projectHeaders = { authorization: `Bearer ${apiKey.body.secret}` };
    const enrollment = await call(`/v1/projects/${projectId}/worker-enrollments`, {
      method: "POST", headers: json, body: JSON.stringify({ worker_name: "billing-worker" }),
    });
    const workerKeys = generateKeyPairSync("ed25519");
    const worker = await call("/v1/worker-enrollments", {
      method: "POST",
      headers: {
        authorization: `Bearer ${enrollment.body.enrollment_token}`, "content-type": "application/json",
      },
      body: JSON.stringify({
        public_key_spki: workerKeys.publicKey.export({ format: "der", type: "spki" })
          .toString("base64url"),
        version: "1.0.0",
        capabilities: { http: true },
      }),
    });
    const workerId = worker.body.worker.id as string;

    const jobRequest = (key: string) => ({
      method: "POST",
      headers: { ...projectHeaders, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        type: "read",
        input: { url: "https://example.com/" },
        data_class: "public",
        placement: { class: "public", pinned_worker_id: null },
        required_capabilities: { http: true },
        budget: {
          deadline_ms: 300_000, max_provider_attempts: 2, max_document_bytes: 1_000_000,
          max_browser_ms: 0, max_browser_contexts: 0,
        },
        policy_version: "2026-11-12",
        upload_private_artifact: false,
      }),
    });

    // Zero balance: the Job is refused before it is stored.
    const refused = await call(`/v1/projects/${projectId}/jobs`, jobRequest("job-1"));
    expect(refused).toMatchObject({
      status: 402, body: { code: "CREDITS_EXHAUSTED", retryable: false },
    });
    expect((await call(`/v1/projects/${projectId}/usage`, { headers: projectHeaders })).body)
      .toMatchObject({ usage: { total_credits: 0 }, credits: { balance_credits: 0 } });

    // Buy a pack: Checkout Session from (recorded) Stripe, then the signed webhook credits it.
    const checkout = await call(`/v1/organizations/${organizationId}/billing/checkout-sessions`, {
      method: "POST", headers: { ...json, "idempotency-key": "buy-1" },
      body: JSON.stringify({ pack_id: "starter" }),
    });
    expect(checkout).toMatchObject({
      status: 201,
      body: { checkout_session: { id: "cs_test_e2e", credits: 100, amount: 500, currency: "usd" } },
    });
    expect(stripeRequests[0]?.get("metadata[organization_id]")).toBe(organizationId);
    const payload = JSON.stringify({
      id: "evt_test_e2e", object: "event", type: "checkout.session.completed",
      data: { object: {
        id: "cs_test_e2e", object: "checkout.session", mode: "payment",
        payment_status: "paid", amount_total: 500, currency: "usd",
      } },
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const stripeSignature = `t=${timestamp},v1=${
      createHmac("sha256", webhookSecret).update(`${timestamp}.${payload}`).digest("hex")}`;
    const webhook = {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "stripe-signature": stripeSignature },
      body: payload,
    };
    expect(await call("/v1/billing/stripe/webhook", webhook)).toMatchObject({
      status: 200, body: { received: true, duplicate: false, credited_credits: 100 },
    });
    expect(await call("/v1/billing/stripe/webhook", webhook)).toMatchObject({
      status: 200, body: { duplicate: true, credited_credits: 0 },
    });
    expect((await call("/v1/billing/stripe/webhook", {
      ...webhook, headers: { ...webhook.headers, "stripe-signature": `t=${timestamp},v1=${"0".repeat(64)}` },
    })).body).toMatchObject({ code: "STRIPE_SIGNATURE_INVALID" });
    expect((await call(`/v1/organizations/${organizationId}/billing`, { headers: human })).body)
      .toMatchObject({ billing: { balance_credits: 100, checkout_enabled: true } });

    // Funded: the same Idempotency-Key now creates the Job, and a real Worker runs it.
    const created = await call(`/v1/projects/${projectId}/jobs`, jobRequest("job-1"));
    expect(created.status).toBe(201);
    const workerDirectory = await mkdtemp(join(tmpdir(), "crawlume-billing-worker-"));
    const outbox = new RemoteWorkerOutbox(join(workerDirectory, "outbox.sqlite"));
    const readerCache = join(workerDirectory, "reader.sqlite");
    try {
      const runner = new RemoteWorkerRunner({
        client: new RemoteWorkerClient(`${origin}/v1`, { fetch: originalFetch }),
        outbox,
        identity: InMemoryWorkerIdentity.fromPkcs8Der(
          workerKeys.privateKey.export({ format: "der", type: "pkcs8" }),
        ),
        workerId,
        adapter: new PublicReadRuntimeAdapter(new ReaderService(
          { ...testConfig(), cachePath: readerCache },
          new UrlPolicy(async () => publicResolver()),
          new PageCache(readerCache),
          new StubFetcher(rawPage({ finalUrl: "https://example.com/" })),
          new StubFetcher(new Error("browser must not run")),
        )),
        claimWaitMs: 0,
      });
      await expect(runner.runOnce(new AbortController().signal)).resolves.toBe("executed");
    } finally {
      outbox.close();
      await rm(workerDirectory, { recursive: true, force: true });
    }
    expect((await call(`/v1/projects/${projectId}/jobs/${created.body.job.id}`, {
      headers: projectHeaders,
    })).body.job).toMatchObject({ status: "completed" });

    const usage = await call(`/v1/projects/${projectId}/usage`, { headers: projectHeaders });
    expect(usage).toMatchObject({
      status: 200,
      body: {
        usage: {
          project_id: projectId,
          meters: [
            { meter: "page_read", quantity: 1, credits: 2 },
            { meter: "browser_read", quantity: 0, credits: 0 },
            { meter: "crawl_page", quantity: 0, credits: 0 },
            { meter: "search_query", quantity: 0, credits: 0 },
          ],
          total_credits: 2,
        },
        credits: { organization_id: organizationId, balance_credits: 98, billing_enabled: true },
      },
    });
  }, 30_000);
});
