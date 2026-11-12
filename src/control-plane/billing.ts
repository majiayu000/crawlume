import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { ControlPlaneJobType } from "./job-input.js";
import type { ControlPlaneDatabase, ControlPlaneQuery, JobBudget } from "./project-scope.js";
import { verifyStripeSignature, type StripeClient } from "./stripe.js";

export const billingMeters = ["page_read", "browser_read", "crawl_page", "search_query"] as const;
export type BillingMeter = (typeof billingMeters)[number];

const creditAmount = z.number().int().nonnegative().safe();
const priceTableSchema = z.object({
  currency: z.string().regex(/^[a-z]{3}$/u),
  meters: z.object({
    page_read: creditAmount,
    browser_read: creditAmount,
    crawl_page: creditAmount,
    search_query: creditAmount,
  }).strict(),
  credit_packs: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
    name: z.string().trim().min(1).max(200),
    credits: z.number().int().positive().safe(),
    amount: z.number().int().positive().safe(),
  }).strict()).max(20),
}).strict().refine(
  (table) => new Set(table.credit_packs.map(({ id }) => id)).size === table.credit_packs.length,
  { message: "credit_packs ids must be unique." },
);

/** Credits charged per meter unit, and credit packs sold for `amount` minor units of `currency`. */
export type BillingPriceTable = z.infer<typeof priceTableSchema>;

export function parseBillingPriceTable(value: unknown): BillingPriceTable {
  return priceTableSchema.parse(value);
}

export async function billingPriceTableFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<BillingPriceTable | null> {
  const path = environment.DIAOYAN_BILLING_PRICES_PATH;
  if (path === undefined || path === "") return null;
  try {
    return parseBillingPriceTable(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    throw new Error("DIAOYAN_BILLING_PRICES_PATH must name a valid billing price table JSON file.", {
      cause: error,
    });
  }
}

export class CreditsExhaustedError extends Error {
  readonly code = "CREDITS_EXHAUSTED";
  constructor(readonly balanceCredits: number, readonly requiredCredits: number) {
    super(
      `The Organization credit balance of ${balanceCredits} is below the ${requiredCredits} ` +
      "credits this Job requires. Buy credits to continue.",
    );
    this.name = "CreditsExhaustedError";
  }
}

export class BillingDisabledError extends Error {
  readonly code = "BILLING_DISABLED";
  constructor(feature: string) {
    super(`${feature} is not configured on this control plane.`);
    this.name = "BillingDisabledError";
  }
}

export class BillingOrganizationNotFoundError extends Error {
  readonly code = "ORGANIZATION_NOT_FOUND";
  constructor() {
    super("The Organization does not exist or is not visible to this user.");
    this.name = "BillingOrganizationNotFoundError";
  }
}

export class BillingAccessDeniedError extends Error {
  readonly code = "BILLING_ACCESS_DENIED";
  constructor() {
    super("Only Organization owners and admins can buy credits.");
    this.name = "BillingAccessDeniedError";
  }
}

export class CreditPackNotFoundError extends Error {
  readonly code = "CREDIT_PACK_NOT_FOUND";
  constructor() {
    super("The credit pack does not exist in the configured price table.");
    this.name = "CreditPackNotFoundError";
  }
}

export class StripeCheckoutMismatchError extends Error {
  readonly code = "STRIPE_CHECKOUT_MISMATCH";
  constructor() {
    super("The paid Stripe Checkout Session does not match the recorded amount and currency.");
    this.name = "StripeCheckoutMismatchError";
  }
}

export class StripeEventInvalidError extends Error {
  readonly code = "STRIPE_EVENT_INVALID";
  constructor() {
    super("The Stripe webhook payload is not a valid event.");
    this.name = "StripeEventInvalidError";
  }
}

export type UsagePeriod = Readonly<{ start: Date; end: Date }>;

export type ProjectUsageSummary = Readonly<{
  projectId: string;
  organizationId: string;
  period: UsagePeriod;
  meters: readonly Readonly<{ meter: BillingMeter; quantity: number; credits: number }>[];
  totalCredits: number;
  balanceCredits: number;
  billingEnabled: boolean;
}>;

export type OrganizationBilling = Readonly<{
  organizationId: string;
  balanceCredits: number;
  prices: BillingPriceTable | null;
  checkoutEnabled: boolean;
}>;

export type CreditCheckout = Readonly<{
  id: string;
  url: string;
  packId: string;
  credits: number;
  amount: number;
  currency: string;
}>;

export type StripeWebhookOutcome = Readonly<{ duplicate: boolean; creditedCredits: number }>;

/** Calendar month in UTC containing `now`, or the month named by `YYYY-MM`. */
export function usagePeriod(now: Date, month: string | null = null): UsagePeriod {
  let year = now.getUTCFullYear();
  let monthIndex = now.getUTCMonth();
  if (month !== null) {
    const matched = /^([0-9]{4})-(0[1-9]|1[0-2])$/u.exec(month);
    if (matched?.[1] === undefined || matched[2] === undefined) {
      throw new TypeError("month must use the YYYY-MM format.");
    }
    year = Number(matched[1]);
    monthIndex = Number(matched[2]) - 1;
  }
  return Object.freeze({
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  });
}

/** Smallest charge a new Job can incur, required as available balance before it is accepted. */
export function minimumJobCredits(
  prices: BillingPriceTable,
  type: ControlPlaneJobType,
  budget: Pick<JobBudget, "maxBrowserMs">,
): number {
  if (type === "search") return prices.meters.search_query;
  if (type === "crawl") return prices.meters.crawl_page;
  return budget.maxBrowserMs > 0
    ? Math.max(prices.meters.page_read, prices.meters.browser_read)
    : prices.meters.page_read;
}

const stripeEventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{1,250}$/u),
  type: z.string().min(1).max(128),
  data: z.object({ object: z.record(z.string(), z.unknown()) }).passthrough(),
}).passthrough();
const stripeCheckoutObjectSchema = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/u),
  mode: z.string(),
  payment_status: z.string(),
  amount_total: z.number().int().nullable(),
  currency: z.string().nullable(),
}).passthrough();
const paidCheckoutEventTypes = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

type MeteredQuantity = Readonly<{ meter: BillingMeter; quantity: number }>;

async function adjustCredits(
  transaction: ControlPlaneQuery,
  organizationId: string,
  credits: number,
  kind: "purchase" | "usage",
  sourceKey: string,
): Promise<number> {
  const updated = await transaction.query<{ balance_credits: string }>(`
    INSERT INTO organization_credit_balances(organization_id, balance_credits, updated_at)
    VALUES ($1, $2, clock_timestamp())
    ON CONFLICT (organization_id) DO UPDATE
      SET balance_credits = organization_credit_balances.balance_credits + EXCLUDED.balance_credits,
        updated_at = EXCLUDED.updated_at
    RETURNING balance_credits::text
  `, [organizationId, credits]);
  const balance = updated.rows[0]?.balance_credits;
  if (balance === undefined) throw new Error("The credit balance update returned no row.");
  await transaction.query(`
    INSERT INTO credit_ledger_entries(id, organization_id, kind, credits, balance_after, source_key)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [randomUUID(), organizationId, kind, credits, balance, sourceKey]);
  return Number(balance);
}

export class BillingService {
  private readonly now: () => Date;
  private readonly prices: BillingPriceTable | null;
  private readonly stripe: Pick<StripeClient, "createCheckoutSession" | "webhookSecret"> | null;

  constructor(
    private readonly database: ControlPlaneDatabase,
    dependencies: Readonly<{
      prices?: BillingPriceTable | null;
      stripe?: Pick<StripeClient, "createCheckoutSession" | "webhookSecret"> | null;
      now?: () => Date;
    }> = {},
  ) {
    this.prices = dependencies.prices ?? null;
    this.stripe = dependencies.stripe ?? null;
    this.now = dependencies.now ?? (() => new Date());
    if (this.stripe !== null && this.prices === null) {
      throw new Error("Stripe checkout requires a billing price table.");
    }
  }

  /**
   * Refuses a new Job when the Organization balance cannot cover its minimum charge. Runs inside the
   * creating transaction; an idempotent replay of an existing Job is never refused.
   */
  async assertJobCreditsAvailable(
    transaction: ControlPlaneQuery,
    projectId: string,
    idempotencyKey: string,
    type: ControlPlaneJobType,
    budget: Pick<JobBudget, "maxBrowserMs">,
  ): Promise<void> {
    if (this.prices === null) return;
    const required = minimumJobCredits(this.prices, type, budget);
    if (required === 0) return;
    const result = await transaction.query<{ replay: boolean; balance: string | null }>(`
      SELECT
        EXISTS(SELECT 1 FROM jobs WHERE project_id = $1 AND idempotency_key = $2) AS replay,
        (SELECT balances.balance_credits FROM projects
          INNER JOIN organization_credit_balances AS balances
            ON balances.organization_id = projects.organization_id
          WHERE projects.id = $1)::text AS balance
    `, [projectId, idempotencyKey]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("The credit balance query returned no row.");
    if (row.replay) return;
    const balance = Number(row.balance ?? 0);
    if (balance < required) throw new CreditsExhaustedError(balance, required);
  }

  /** Meters a Job that just completed on `leaseId` and debits its Organization in the same transaction. */
  async recordJobUsage(
    transaction: ControlPlaneQuery,
    job: Readonly<{ id: string; projectId: string; type: ControlPlaneJobType }>,
    leaseId: string,
    occurredAt: Date,
  ): Promise<void> {
    const quantities = await this.jobQuantities(transaction, job, leaseId);
    let organizationId: string | null = null;
    let totalCredits = 0;
    for (const { meter, quantity } of quantities) {
      const unitCredits = this.prices?.meters[meter] ?? 0;
      const credits = unitCredits * quantity;
      if (!Number.isSafeInteger(credits)) throw new Error("The metered charge is not a safe integer.");
      const inserted = await transaction.query<{ organization_id: string }>(`
        INSERT INTO usage_events(
          id, organization_id, project_id, job_id, meter, quantity, unit_credits, credits, occurred_at
        )
        SELECT $1, projects.organization_id, projects.id, $3, $4, $5, $6, $7, $8
        FROM projects WHERE projects.id = $2
        ON CONFLICT (job_id, meter) DO NOTHING
        RETURNING organization_id
      `, [randomUUID(), job.projectId, job.id, meter, quantity, unitCredits, credits, occurredAt]);
      const row = inserted.rows[0];
      if (row === undefined) continue;
      organizationId = row.organization_id;
      totalCredits += credits;
    }
    if (organizationId !== null && totalCredits > 0) {
      await adjustCredits(transaction, organizationId, -totalCredits, "usage", `job:${job.id}`);
    }
  }

  private async jobQuantities(
    transaction: ControlPlaneQuery,
    job: Readonly<{ projectId: string; type: ControlPlaneJobType }>,
    leaseId: string,
  ): Promise<readonly MeteredQuantity[]> {
    if (job.type === "search") return [{ meter: "search_query", quantity: 1 }];
    const counted = await transaction.query<{ browser: string; other: string }>(`
      SELECT
        count(*) FILTER (WHERE provider = 'browser')::text AS browser,
        count(*) FILTER (WHERE provider IS DISTINCT FROM 'browser')::text AS other
      FROM job_events
      WHERE lease_id = $1 AND project_id = $2 AND event_type = 'page.read'
    `, [leaseId, job.projectId]);
    const browser = Number(counted.rows[0]?.browser ?? 0);
    const other = Number(counted.rows[0]?.other ?? 0);
    const quantities: MeteredQuantity[] = job.type === "crawl"
      ? [{ meter: "crawl_page", quantity: browser + other }]
      : [{ meter: "page_read", quantity: other }, { meter: "browser_read", quantity: browser }];
    return quantities.filter(({ quantity }) => quantity > 0);
  }

  async projectUsage(projectId: string, period: UsagePeriod): Promise<ProjectUsageSummary> {
    const result = await this.database.query<{
      organization_id: string;
      balance: string | null;
      meters: Readonly<Record<string, Readonly<{ quantity: string; credits: string }>>> | null;
    }>(`
      SELECT projects.organization_id,
        balances.balance_credits::text AS balance,
        (SELECT jsonb_object_agg(meter, jsonb_build_object(
            'quantity', quantity::text, 'credits', credits::text))
          FROM (
            SELECT meter, sum(quantity) AS quantity, sum(credits) AS credits
            FROM usage_events
            WHERE project_id = projects.id AND occurred_at >= $2 AND occurred_at < $3
            GROUP BY meter
          ) AS totals) AS meters
      FROM projects
      LEFT JOIN organization_credit_balances AS balances
        ON balances.organization_id = projects.organization_id
      WHERE projects.id = $1
    `, [projectId, period.start, period.end]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("The Project usage query returned no row.");
    const meters = billingMeters.map((meter) => Object.freeze({
      meter,
      quantity: Number(row.meters?.[meter]?.quantity ?? 0),
      credits: Number(row.meters?.[meter]?.credits ?? 0),
    }));
    return Object.freeze({
      projectId,
      organizationId: row.organization_id,
      period,
      meters,
      totalCredits: meters.reduce((sum, { credits }) => sum + credits, 0),
      balanceCredits: Number(row.balance ?? 0),
      billingEnabled: this.prices !== null,
    });
  }

  async organizationBilling(userId: string, organizationId: string): Promise<OrganizationBilling> {
    await this.membershipRole(userId, organizationId);
    const result = await this.database.query<{ balance: string }>(`
      SELECT balance_credits::text AS balance FROM organization_credit_balances
      WHERE organization_id = $1
    `, [organizationId]);
    return Object.freeze({
      organizationId,
      balanceCredits: Number(result.rows[0]?.balance ?? 0),
      prices: this.prices,
      checkoutEnabled: this.stripe !== null,
    });
  }

  async createCheckout(
    userId: string,
    organizationId: string,
    packId: string,
    idempotencyKey: string,
  ): Promise<CreditCheckout> {
    const role = await this.membershipRole(userId, organizationId);
    if (role !== "owner" && role !== "admin") throw new BillingAccessDeniedError();
    if (this.stripe === null || this.prices === null) throw new BillingDisabledError("Stripe checkout");
    const pack = this.prices.credit_packs.find(({ id }) => id === packId);
    if (pack === undefined) throw new CreditPackNotFoundError();
    const session = await this.stripe.createCheckoutSession({
      organizationId,
      packId: pack.id,
      productName: pack.name,
      credits: pack.credits,
      amountMinor: pack.amount,
      currency: this.prices.currency,
      idempotencyKey: `crawlume-checkout:${organizationId}:${idempotencyKey}`,
    });
    await this.database.query(`
      INSERT INTO billing_checkout_sessions(
        id, organization_id, created_by_user_id, pack_id, credits, amount_minor, currency, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [session.id, organizationId, userId, pack.id, pack.credits, pack.amount, this.prices.currency]);
    return Object.freeze({
      id: session.id,
      url: session.url,
      packId: pack.id,
      credits: pack.credits,
      amount: pack.amount,
      currency: this.prices.currency,
    });
  }

  /**
   * Verifies and applies one Stripe webhook delivery. The event id is recorded in the crediting
   * transaction, so a redelivery is acknowledged without crediting twice and a failure is retried.
   */
  async handleStripeWebhook(
    payload: Buffer | undefined,
    signature: string | null,
  ): Promise<StripeWebhookOutcome> {
    if (this.stripe === null) throw new BillingDisabledError("Stripe checkout");
    if (payload === undefined) throw new StripeEventInvalidError();
    verifyStripeSignature(
      payload, signature, this.stripe.webhookSecret, Math.floor(this.now().getTime() / 1_000),
    );
    let event: z.infer<typeof stripeEventSchema>;
    try {
      event = stripeEventSchema.parse(JSON.parse(payload.toString("utf8")) as unknown);
    } catch {
      throw new StripeEventInvalidError();
    }
    return this.database.transaction(async (transaction) => {
      const recorded = await transaction.query<{ id: string }>(`
        INSERT INTO stripe_webhook_events(id, type) VALUES ($1, $2)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, [event.id, event.type]);
      if (recorded.rows[0] === undefined) return { duplicate: true, creditedCredits: 0 };
      if (!paidCheckoutEventTypes.has(event.type)) return { duplicate: false, creditedCredits: 0 };
      const parsed = stripeCheckoutObjectSchema.safeParse(event.data.object);
      if (!parsed.success) throw new StripeEventInvalidError();
      const checkout = parsed.data;
      if (checkout.mode !== "payment" || checkout.payment_status !== "paid") {
        return { duplicate: false, creditedCredits: 0 };
      }
      const open = await transaction.query<{
        organization_id: string;
        credits: string;
        amount_minor: string;
        currency: string;
      }>(`
        SELECT organization_id, credits::text, amount_minor::text, currency
        FROM billing_checkout_sessions
        WHERE id = $1 AND status = 'open'
        FOR UPDATE
      `, [checkout.id]);
      const session = open.rows[0];
      // Sessions created elsewhere on the same Stripe account, or already credited, are ignored.
      if (session === undefined) return { duplicate: false, creditedCredits: 0 };
      if (checkout.amount_total !== Number(session.amount_minor) ||
          checkout.currency !== session.currency) {
        throw new StripeCheckoutMismatchError();
      }
      await transaction.query(`
        UPDATE billing_checkout_sessions SET status = 'completed', completed_at = clock_timestamp()
        WHERE id = $1 AND status = 'open'
      `, [checkout.id]);
      const credits = Number(session.credits);
      await adjustCredits(
        transaction, session.organization_id, credits, "purchase", `stripe_checkout:${checkout.id}`,
      );
      return { duplicate: false, creditedCredits: credits };
    });
  }

  private async membershipRole(userId: string, organizationId: string): Promise<string> {
    const result = await this.database.query<{ role: string }>(`
      SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2
    `, [organizationId, userId]);
    const role = result.rows[0]?.role;
    if (role === undefined) throw new BillingOrganizationNotFoundError();
    return role;
  }
}
