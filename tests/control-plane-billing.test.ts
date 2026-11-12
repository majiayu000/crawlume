import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedProjectApiKey } from "../src/control-plane/api-key-service.js";
import {
  BillingService,
  CreditsExhaustedError,
  billingPriceTableFromEnvironment,
  minimumJobCredits,
  parseBillingPriceTable,
  usagePeriod,
  type ProjectUsageSummary,
} from "../src/control-plane/billing.js";
import { BillingHttpApi } from "../src/control-plane/billing-http-api.js";
import { ProjectJobHttpApi } from "../src/control-plane/project-http-api.js";
import type { ControlPlaneDatabase } from "../src/control-plane/project-scope.js";
import {
  StripeClient,
  StripeSignatureError,
  stripeConfigFromEnvironment,
  verifyStripeSignature,
} from "../src/control-plane/stripe.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const organizationId = "11111111-1111-4111-8111-111111111111";
const requestId = "99999999-9999-4999-8999-999999999999";
const webhookSecret = "whsec_testsecret";
const prices = parseBillingPriceTable({
  currency: "usd",
  meters: { page_read: 1, browser_read: 5, crawl_page: 2, search_query: 3 },
  credit_packs: [{ id: "starter", name: "Starter credits", credits: 1_000, amount: 500 }],
});

function signed(payload: string, timestamp: number, secret = webhookSecret): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("billing price table", () => {
  it("requires every meter to be priced and pack ids to be unique", () => {
    expect(() => parseBillingPriceTable({
      currency: "usd", meters: { page_read: 1 }, credit_packs: [],
    })).toThrow();
    expect(() => parseBillingPriceTable({
      ...prices,
      credit_packs: [prices.credit_packs[0], prices.credit_packs[0]],
    })).toThrow(/unique/u);
    expect(() => parseBillingPriceTable({ ...prices, meters: { ...prices.meters, page_read: -1 } }))
      .toThrow();
  });

  it("loads the price table from DIAOYAN_BILLING_PRICES_PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crawlume-billing-"));
    try {
      const path = join(directory, "prices.json");
      await writeFile(path, JSON.stringify(prices));
      await expect(billingPriceTableFromEnvironment({})).resolves.toBeNull();
      await expect(billingPriceTableFromEnvironment({ DIAOYAN_BILLING_PRICES_PATH: path }))
        .resolves.toEqual(prices);
      await writeFile(path, "{}");
      await expect(billingPriceTableFromEnvironment({ DIAOYAN_BILLING_PRICES_PATH: path }))
        .rejects.toThrow(/DIAOYAN_BILLING_PRICES_PATH/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires the minimum possible charge of each Job type", () => {
    expect(minimumJobCredits(prices, "read", { maxBrowserMs: 0 })).toBe(1);
    expect(minimumJobCredits(prices, "read", { maxBrowserMs: 30_000 })).toBe(5);
    expect(minimumJobCredits(prices, "crawl", { maxBrowserMs: 0 })).toBe(2);
    expect(minimumJobCredits(prices, "search", { maxBrowserMs: 0 })).toBe(3);
  });

  it("selects UTC calendar months", () => {
    const now = new Date("2026-11-12T08:00:00.000Z");
    expect(usagePeriod(now)).toEqual({
      start: new Date("2026-11-01T00:00:00.000Z"), end: new Date("2026-12-01T00:00:00.000Z"),
    });
    expect(usagePeriod(now, "2026-12")).toEqual({
      start: new Date("2026-12-01T00:00:00.000Z"), end: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(() => usagePeriod(now, "2026-13")).toThrow(TypeError);
  });
});

describe("Stripe test-mode integration", () => {
  it("accepts only test-mode secret keys", () => {
    const environment = {
      DIAOYAN_STRIPE_WEBHOOK_SECRET: webhookSecret,
      DIAOYAN_BILLING_CHECKOUT_SUCCESS_URL: "https://app.example/billing/success",
      DIAOYAN_BILLING_CHECKOUT_CANCEL_URL: "https://app.example/billing/cancel",
    };
    expect(stripeConfigFromEnvironment({})).toBeNull();
    expect(() => stripeConfigFromEnvironment({
      ...environment, DIAOYAN_STRIPE_SECRET_KEY: "sk_live_abc",
    })).toThrow(/test-mode/u);
    expect(stripeConfigFromEnvironment({ ...environment, DIAOYAN_STRIPE_SECRET_KEY: "sk_test_abc" }))
      .toMatchObject({ secretKey: "sk_test_abc", webhookSecret });
  });

  it("verifies v1 signatures within the replay tolerance", () => {
    const payload = '{"id":"evt_1"}';
    const now = 1_800_000_000;
    expect(() => verifyStripeSignature(Buffer.from(payload), signed(payload, now), webhookSecret, now))
      .not.toThrow();
    const rotated = `${signed(payload, now, "whsec_old")},v1=${signed(payload, now).split("v1=")[1]}`;
    expect(() => verifyStripeSignature(Buffer.from(payload), rotated, webhookSecret, now)).not.toThrow();
    for (const header of [
      null,
      signed('{"id":"evt_2"}', now),
      signed(payload, now - 301),
      signed(payload, now, "whsec_other"),
      `t=${now}`,
    ]) {
      expect(() => verifyStripeSignature(Buffer.from(payload), header, webhookSecret, now))
        .toThrow(StripeSignatureError);
    }
  });

  it("creates a payment Checkout Session with the documented form encoding", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123", object: "checkout.session",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new StripeClient({
      secretKey: "sk_test_abc",
      webhookSecret,
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
    }, { fetch });
    await expect(client.createCheckoutSession({
      organizationId, packId: "starter", productName: "Starter credits", credits: 1_000,
      amountMinor: 500, currency: "usd", idempotencyKey: "key-1",
    })).resolves.toEqual({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk_test_abc",
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": "key-1",
    });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      mode: "payment",
      success_url: "https://app.example/success",
      cancel_url: "https://app.example/cancel",
      client_reference_id: organizationId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "500",
      "line_items[0][price_data][product_data][name]": "Starter credits",
      "metadata[organization_id]": organizationId,
      "metadata[pack_id]": "starter",
      "metadata[credits]": "1000",
    });
  });

  it("rejects a webhook before touching the database when its signature is invalid", async () => {
    const database = { query: vi.fn(), transaction: vi.fn() } as unknown as ControlPlaneDatabase;
    const billing = new BillingService(database, {
      prices,
      stripe: { webhookSecret, createCheckoutSession: vi.fn() },
      now: () => new Date(1_800_000_000_000),
    });
    const api = new BillingHttpApi({ authenticateAccessToken: vi.fn(), billing }, {
      requestId: () => requestId,
    });
    const payload = '{"id":"evt_1","type":"checkout.session.completed","data":{"object":{}}}';
    const response = await api.handle({
      method: "POST",
      path: "/v1/billing/stripe/webhook",
      headers: { "stripe-signature": signed(payload, 1_800_000_000, "whsec_forged") },
      body: JSON.parse(payload) as unknown,
      rawBody: Buffer.from(payload),
    });
    expect(response).toMatchObject({ status: 400, body: { code: "STRIPE_SIGNATURE_INVALID" } });
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

describe("billing over the Project HTTP API", () => {
  const identity: AuthenticatedProjectApiKey = Object.freeze({
    apiKeyId: "key-a",
    projectId,
    organizationId,
    createdByUserId: "user-a",
    scopes: ["tasks:write", "results:read"] as const,
  });

  function api(services: Partial<ConstructorParameters<typeof ProjectJobHttpApi>[0]>) {
    return new ProjectJobHttpApi({
      authenticate: vi.fn(async () => identity),
      createJob: vi.fn(),
      getJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      listPublications: vi.fn(),
      listAuditEvents: vi.fn(),
      ...services,
    }, { requestId: () => requestId, now: () => new Date("2026-11-12T08:00:00.000Z") });
  }

  it("rejects Job creation at zero balance with CREDITS_EXHAUSTED", async () => {
    const response = await api({
      createJob: vi.fn(async () => { throw new CreditsExhaustedError(0, 1); }),
    }).handle({
      method: "POST",
      path: `/v1/projects/${projectId}/jobs`,
      headers: {
        authorization: `Bearer dya_live_deadbeef_${"A".repeat(43)}`,
        "content-type": "application/json",
        "idempotency-key": "job-1",
      },
      body: {
        type: "read",
        input: { url: "https://example.com/" },
        data_class: "public",
        placement: { class: "public", pinned_worker_id: null },
        required_capabilities: { http: true },
        budget: {
          deadline_ms: 60_000, max_provider_attempts: 1, max_document_bytes: 1_000,
          max_browser_ms: 0, max_browser_contexts: 0,
        },
        policy_version: "v1",
        upload_private_artifact: false,
      },
    });
    expect(response).toMatchObject({
      status: 402,
      headers: { "content-type": "application/problem+json" },
      body: { code: "CREDITS_EXHAUSTED", status: 402, retryable: false },
    });
  });

  it("summarizes usage for the requested month", async () => {
    const summary: ProjectUsageSummary = {
      projectId,
      organizationId,
      period: usagePeriod(new Date(), "2026-10"),
      meters: [
        { meter: "page_read", quantity: 3, credits: 3 },
        { meter: "browser_read", quantity: 1, credits: 5 },
        { meter: "crawl_page", quantity: 0, credits: 0 },
        { meter: "search_query", quantity: 0, credits: 0 },
      ],
      totalCredits: 8,
      balanceCredits: 92,
      billingEnabled: true,
    };
    const projectUsage = vi.fn(async () => summary);
    const response = await api({ projectUsage }).handle({
      method: "GET",
      path: `/v1/projects/${projectId}/usage`,
      query: "?month=2026-10",
      headers: { authorization: `Bearer dya_live_deadbeef_${"A".repeat(43)}` },
      body: null,
    });
    expect(projectUsage).toHaveBeenCalledWith(projectId, usagePeriod(new Date(), "2026-10"));
    expect(response).toMatchObject({
      status: 200,
      body: {
        usage: {
          project_id: projectId,
          period_start: "2026-10-01T00:00:00.000Z",
          period_end: "2026-11-01T00:00:00.000Z",
          total_credits: 8,
        },
        credits: { organization_id: organizationId, balance_credits: 92, billing_enabled: true },
      },
    });
    const invalid = await api({ projectUsage }).handle({
      method: "GET",
      path: `/v1/projects/${projectId}/usage`,
      query: "?month=october",
      headers: { authorization: `Bearer dya_live_deadbeef_${"A".repeat(43)}` },
      body: null,
    });
    expect(invalid).toMatchObject({ status: 400, body: { code: "PROJECT_QUERY_INVALID" } });
  });
});
