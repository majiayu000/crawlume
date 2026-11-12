import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

// Minimal Stripe REST client for Checkout in test mode, following https://docs.stripe.com/api.

const stripeApiOrigin = "https://api.stripe.com";
const signatureToleranceSeconds = 300;

export type StripeConfig = Readonly<{
  secretKey: string;
  webhookSecret: string;
  successUrl: string;
  cancelUrl: string;
}>;

export class StripeSignatureError extends Error {
  readonly code = "STRIPE_SIGNATURE_INVALID";
  constructor() {
    super("The Stripe-Signature header does not verify for this payload.");
    this.name = "StripeSignatureError";
  }
}

export class StripeRequestError extends Error {
  readonly code = "STRIPE_REQUEST_FAILED";
  constructor(readonly status: number) {
    super(`Stripe rejected the request with HTTP ${status}.`);
    this.name = "StripeRequestError";
  }
}

function requireHttpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use https outside localhost.`);
  }
  return url.toString();
}

/** Returns null when Stripe is not configured; refuses live-mode keys. */
export function stripeConfigFromEnvironment(environment: NodeJS.ProcessEnv): StripeConfig | null {
  const secretKey = environment.DIAOYAN_STRIPE_SECRET_KEY;
  if (secretKey === undefined || secretKey === "") return null;
  if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/u.test(secretKey)) {
    throw new Error("DIAOYAN_STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_ or rk_test_).");
  }
  const webhookSecret = environment.DIAOYAN_STRIPE_WEBHOOK_SECRET ?? "";
  if (!/^whsec_[A-Za-z0-9]+$/u.test(webhookSecret)) {
    throw new Error("DIAOYAN_STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_).");
  }
  return Object.freeze({
    secretKey,
    webhookSecret,
    successUrl: requireHttpsUrl(
      environment.DIAOYAN_BILLING_CHECKOUT_SUCCESS_URL ?? "", "DIAOYAN_BILLING_CHECKOUT_SUCCESS_URL",
    ),
    cancelUrl: requireHttpsUrl(
      environment.DIAOYAN_BILLING_CHECKOUT_CANCEL_URL ?? "", "DIAOYAN_BILLING_CHECKOUT_CANCEL_URL",
    ),
  });
}

/** Verifies a Stripe-Signature header (scheme v1: HMAC-SHA256 over `${t}.${payload}`). */
export function verifyStripeSignature(
  payload: Buffer,
  header: string | null,
  secret: string,
  nowSeconds: number,
): void {
  if (header === null) throw new StripeSignatureError();
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^[0-9]{1,12}$/u.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/u.test(value)) signatures.push(Buffer.from(value, "hex"));
  }
  if (timestamp === null || signatures.length === 0 ||
      Math.abs(nowSeconds - timestamp) > signatureToleranceSeconds) {
    throw new StripeSignatureError();
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();
  if (!signatures.some((signature) => timingSafeEqual(signature, expected))) {
    throw new StripeSignatureError();
  }
}

export type StripeCheckoutRequest = Readonly<{
  organizationId: string;
  packId: string;
  productName: string;
  credits: number;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}>;

export type StripeCheckoutSession = Readonly<{ id: string; url: string }>;

const checkoutSessionSchema = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/u),
  url: z.string().url(),
}).passthrough();

export class StripeClient {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly config: StripeConfig,
    dependencies: Readonly<{ fetch?: typeof fetch }> = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
  }

  get webhookSecret(): string {
    return this.config.webhookSecret;
  }

  async createCheckoutSession(request: StripeCheckoutRequest): Promise<StripeCheckoutSession> {
    const form = new URLSearchParams({
      mode: "payment",
      success_url: this.config.successUrl,
      cancel_url: this.config.cancelUrl,
      client_reference_id: request.organizationId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": request.currency,
      "line_items[0][price_data][unit_amount]": String(request.amountMinor),
      "line_items[0][price_data][product_data][name]": request.productName,
      "metadata[organization_id]": request.organizationId,
      "metadata[pack_id]": request.packId,
      "metadata[credits]": String(request.credits),
    });
    const response = await this.fetch(`${stripeApiOrigin}/v1/checkout/sessions`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": request.idempotencyKey,
      },
      body: form.toString(),
    });
    if (!response.ok) throw new StripeRequestError(response.status);
    const parsed = checkoutSessionSchema.parse(await response.json() as unknown);
    return Object.freeze({ id: parsed.id, url: parsed.url });
  }
}
