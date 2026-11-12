import { createHmac, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BillingService,
  CreditsExhaustedError,
  StripeCheckoutMismatchError,
  parseBillingPriceTable,
  usagePeriod,
} from "../src/control-plane/billing.js";
import { runControlPlaneMigrations } from "../src/control-plane/migrations.js";
import { JobResultService } from "../src/control-plane/organization-authorization.js";
import { ControlPlaneJobService } from "../src/control-plane/project-scope.js";
import { PostgresControlPlaneDatabase } from "../src/server.js";
import {
  configuredDatabaseUrl,
  databaseClock,
  databaseUrl,
  eventInput,
  fixture,
  fixtureProjectKey,
  fixtureWorker,
  jobInput,
  quotedTestDatabase,
  requiredDatabaseUrl,
  seedRuntimeFixture,
} from "./control-plane-job-fixture.js";

const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;
const webhookSecret = "whsec_billingtest";
const prices = parseBillingPriceTable({
  currency: "usd",
  meters: { page_read: 2, browser_read: 7, crawl_page: 1, search_query: 3 },
  credit_packs: [{ id: "starter", name: "Starter credits", credits: 100, amount: 500 }],
});

function signedEvent(event: unknown, nowSeconds: number): { payload: Buffer; signature: string } {
  const payload = Buffer.from(JSON.stringify(event));
  const digest = createHmac("sha256", webhookSecret)
    .update(`${nowSeconds}.`).update(payload).digest("hex");
  return { payload, signature: `t=${nowSeconds},v1=${digest}` };
}

function paidCheckoutEvent(eventId: string, sessionId: string, amountTotal = 500): unknown {
  return {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId, object: "checkout.session", mode: "payment", payment_status: "paid",
        amount_total: amountTotal, currency: "usd",
      },
    },
  };
}

describeWithPostgres("control-plane billing on PostgreSQL", () => {
  let administration: Pool;
  let database: Pool | undefined;
  let databaseName: string | undefined;

  beforeAll(async () => {
    administration = new Pool({ connectionString: requiredDatabaseUrl(), max: 1 });
  });

  beforeEach(async () => {
    databaseName = `diaoyan_test_${randomUUID().replaceAll("-", "")}`;
    await administration.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
    database = new Pool({ connectionString: databaseUrl(databaseName), max: 2 });
    await runControlPlaneMigrations(database);
    await seedRuntimeFixture(database);
  });

  afterEach(async () => {
    await database?.end();
    database = undefined;
    if (databaseName !== undefined) {
      await administration.query(`DROP DATABASE ${quotedTestDatabase(databaseName)}`);
      databaseName = undefined;
    }
  });

  afterAll(async () => {
    await administration.end();
  });

  async function balance(): Promise<number> {
    const result = await database!.query<{ balance: string }>(`
      SELECT balance_credits::text AS balance FROM organization_credit_balances
      WHERE organization_id = $1
    `, [fixture.organizationId]);
    return Number(result.rows[0]?.balance ?? 0);
  }

  async function grant(credits: number): Promise<void> {
    await database!.query(`
      INSERT INTO organization_credit_balances(organization_id, balance_credits) VALUES ($1, $2)
    `, [fixture.organizationId, credits]);
  }

  it("refuses Job creation at zero balance but replays an existing Job", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const billing = new BillingService(storage, { prices });
    const jobs = new ControlPlaneJobService(storage, { now: () => now, billing });
    const context = { correlationId: "billing-zero" };

    await expect(jobs.createJob(fixtureProjectKey, "zero", jobInput("https://example.com/a"), context))
      .rejects.toEqual(new CreditsExhaustedError(0, 2));
    const browserJob = { ...jobInput("https://example.com/b"), budget: {
      ...jobInput("https://example.com/b").budget, maxBrowserMs: 30_000,
    } };
    await grant(2);
    const created = await jobs.createJob(fixtureProjectKey, "funded", jobInput("https://example.com/a"), context);
    await expect(jobs.createJob(fixtureProjectKey, "browser", browserJob, context))
      .rejects.toBeInstanceOf(CreditsExhaustedError);
    await database!.query("UPDATE organization_credit_balances SET balance_credits = 0");
    await expect(jobs.createJob(fixtureProjectKey, "funded", jobInput("https://example.com/a"), context))
      .resolves.toMatchObject({ id: created.id });
    const stored = await database!.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs");
    expect(stored.rows[0]?.count).toBe("1");
  });

  it("meters completed pages by provider and debits the Organization once", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const billing = new BillingService(storage, { prices });
    const jobs = new ControlPlaneJobService(storage, { now: () => now, billing });
    const results = new JobResultService(storage);
    await grant(20);

    const created = await jobs.createJob(fixtureProjectKey, "metered", jobInput("https://example.com/m"), {
      correlationId: "billing-meter",
    });
    const claim = await jobs.claimNext(fixtureWorker);
    if (claim === null) throw new Error("The metered Job was not claimed.");
    await results.appendEvent(fixtureWorker, claim.lease.id, claim.lease.generation, {
      ...eventInput(1), eventType: "page.read", provider: "http",
    });
    await results.appendEvent(fixtureWorker, claim.lease.id, claim.lease.generation, {
      ...eventInput(2), eventType: "page.read", provider: "browser",
    });
    await results.appendEvent(fixtureWorker, claim.lease.id, claim.lease.generation, {
      ...eventInput(3), eventType: "page-fetched", provider: "http",
    });
    await jobs.complete(fixtureWorker, claim.lease.id, claim.lease.generation, {
      status: "completed", resultCompleteness: "complete", errorCode: null,
    });

    const usage = await database!.query<{ meter: string; quantity: string; credits: string }>(`
      SELECT meter, quantity::text, credits::text FROM usage_events WHERE job_id = $1 ORDER BY meter
    `, [created.id]);
    expect(usage.rows).toEqual([
      { meter: "browser_read", quantity: "1", credits: "7" },
      { meter: "page_read", quantity: "1", credits: "2" },
    ]);
    expect(await balance()).toBe(11);
    const ledger = await database!.query<{ kind: string; credits: string; balance_after: string }>(`
      SELECT kind, credits::text, balance_after::text FROM credit_ledger_entries
      WHERE source_key = $1
    `, [`job:${created.id}`]);
    expect(ledger.rows).toEqual([{ kind: "usage", credits: "-9", balance_after: "11" }]);

    const summary = await billing.projectUsage(fixture.projectId, usagePeriod(now));
    expect(summary).toMatchObject({
      organizationId: fixture.organizationId,
      totalCredits: 9,
      balanceCredits: 11,
      billingEnabled: true,
    });
    expect(summary.meters).toEqual([
      { meter: "page_read", quantity: 1, credits: 2 },
      { meter: "browser_read", quantity: 1, credits: 7 },
      { meter: "crawl_page", quantity: 0, credits: 0 },
      { meter: "search_query", quantity: 0, credits: 0 },
    ]);
  });

  it("does not meter failed Jobs and meters at zero credits without a price table", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const now = await databaseClock(database!);
    const jobs = new ControlPlaneJobService(storage, {
      now: () => now, billing: new BillingService(storage),
    });
    const results = new JobResultService(storage);
    for (const [key, status] of [["failed", "failed"], ["free", "completed"]] as const) {
      await jobs.createJob(fixtureProjectKey, key, jobInput(`https://example.com/${key}`), {
        correlationId: key,
      });
      const claim = await jobs.claimNext(fixtureWorker);
      if (claim === null) throw new Error("The Job was not claimed.");
      await results.appendEvent(fixtureWorker, claim.lease.id, claim.lease.generation, {
        ...eventInput(1), eventType: "page.read",
      });
      await jobs.complete(fixtureWorker, claim.lease.id, claim.lease.generation, status === "failed"
        ? { status, resultCompleteness: null, errorCode: "FETCH_TIMEOUT" }
        : { status, resultCompleteness: "complete", errorCode: null });
    }
    const usage = await database!.query<{ meter: string; credits: string }>(`
      SELECT meter, credits::text FROM usage_events
    `);
    expect(usage.rows).toEqual([{ meter: "page_read", credits: "0" }]);
    expect(await balance()).toBe(0);
  });

  it("credits a paid Checkout Session exactly once per verified Stripe event", async () => {
    const storage = new PostgresControlPlaneDatabase(database!);
    const nowSeconds = 1_900_000_000;
    const createCheckoutSession = vi.fn(async () => ({
      id: "cs_test_billing", url: "https://checkout.stripe.com/c/pay/cs_test_billing",
    }));
    const billing = new BillingService(storage, {
      prices,
      stripe: { webhookSecret, createCheckoutSession },
      now: () => new Date(nowSeconds * 1_000),
    });
    await database!.query(`
      INSERT INTO organization_memberships(organization_id, user_id, role) VALUES ($1, $2, 'owner')
    `, [fixture.organizationId, fixture.userId]);

    await expect(billing.createCheckout(fixture.userId, fixture.organizationId, "starter", "buy-1"))
      .resolves.toMatchObject({ id: "cs_test_billing", credits: 100, amount: 500, currency: "usd" });
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `crawlume-checkout:${fixture.organizationId}:buy-1`,
    }));

    const mismatch = signedEvent(paidCheckoutEvent("evt_mismatch", "cs_test_billing", 1), nowSeconds);
    await expect(billing.handleStripeWebhook(mismatch.payload, mismatch.signature))
      .rejects.toBeInstanceOf(StripeCheckoutMismatchError);
    expect(await balance()).toBe(0);

    const paid = signedEvent(paidCheckoutEvent("evt_paid", "cs_test_billing"), nowSeconds);
    await expect(billing.handleStripeWebhook(paid.payload, paid.signature))
      .resolves.toEqual({ duplicate: false, creditedCredits: 100 });
    await expect(billing.handleStripeWebhook(paid.payload, paid.signature))
      .resolves.toEqual({ duplicate: true, creditedCredits: 0 });
    const again = signedEvent(paidCheckoutEvent("evt_paid_again", "cs_test_billing"), nowSeconds);
    await expect(billing.handleStripeWebhook(again.payload, again.signature))
      .resolves.toEqual({ duplicate: false, creditedCredits: 0 });
    expect(await balance()).toBe(100);
    const sessions = await database!.query<{ status: string }>(`
      SELECT status FROM billing_checkout_sessions WHERE id = 'cs_test_billing'
    `);
    expect(sessions.rows).toEqual([{ status: "completed" }]);
  });
});
