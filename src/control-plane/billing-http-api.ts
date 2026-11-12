import { randomUUID } from "node:crypto";

import { z, ZodError } from "zod";

import {
  BillingAccessDeniedError,
  BillingDisabledError,
  BillingOrganizationNotFoundError,
  CreditPackNotFoundError,
  StripeCheckoutMismatchError,
  StripeEventInvalidError,
  type BillingService,
} from "./billing.js";
import {
  AccessTokenAuthenticationError,
  type OidcSessionService,
} from "./oidc-session-service.js";
import type { WorkerHttpRequest, WorkerHttpResponse } from "./organization-service.js";
import { controlPlaneHeader, isJsonControlPlaneRequest } from "./project-http-api.js";
import { billingRouteDefinitions } from "./router-contract.js";
import { StripeRequestError, StripeSignatureError } from "./stripe.js";

type BillingHttpServices = Readonly<{
  authenticateAccessToken: OidcSessionService["verifyAccessToken"];
  billing: Pick<BillingService,
    "organizationBilling" | "createCheckout" | "handleStripeWebhook">;
}>;

type BillingRoute = Readonly<{
  kind: (typeof billingRouteDefinitions)[number]["kind"];
  method: string;
  organizationId: string | null;
}>;

class BillingRequestError extends Error {
  readonly code = "BILLING_REQUEST_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "BillingRequestError";
  }
}

const checkoutBodySchema = z.object({
  pack_id: z.string().min(1).max(64),
}).strict();

function matchRoute(path: string): BillingRoute | null {
  for (const definition of billingRouteDefinitions) {
    const matched = definition.pattern.exec(path);
    if (matched === null) continue;
    return { kind: definition.kind, method: definition.method, organizationId: matched[1] ?? null };
  }
  return null;
}

function accessToken(request: WorkerHttpRequest): string {
  const authorization = controlPlaneHeader(request, "authorization");
  const matched = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(
    authorization ?? "",
  );
  if (matched?.[1] === undefined) throw new AccessTokenAuthenticationError();
  return matched[1];
}

function response(status: number, requestId: string, body: unknown): WorkerHttpResponse {
  return {
    status,
    headers: Object.freeze({
      "content-type": "application/json",
      "x-request-id": requestId,
      "cache-control": "no-store",
    }),
    body,
  };
}

function problem(
  request: WorkerHttpRequest,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
): WorkerHttpResponse {
  return {
    status,
    headers: Object.freeze({
      "content-type": "application/problem+json",
      "x-request-id": requestId,
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    }),
    body: {
      type: `https://api.diaoyan.example/errors/${code.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      detail,
      instance: request.path,
      code,
      request_id: requestId,
      retryable: status === 500 || status === 502,
    },
  };
}

export class BillingHttpApi {
  private readonly requestId: () => string;

  constructor(
    private readonly services: BillingHttpServices,
    dependencies: Readonly<{ requestId?: () => string }> = {},
  ) {
    this.requestId = dependencies.requestId ?? randomUUID;
  }

  async handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const requestId = this.requestId();
    const route = matchRoute(request.path);
    if (route === null) {
      return problem(request, requestId, 404, "BILLING_ROUTE_NOT_FOUND", "Not Found",
        "The billing route does not exist.");
    }
    if (request.method.toUpperCase() !== route.method) {
      const result = problem(request, requestId, 405, "BILLING_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The billing route does not accept this method.");
      return { ...result, headers: { ...result.headers, allow: route.method } };
    }
    try {
      if ((request.query ?? "") !== "") throw new BillingRequestError("Billing routes take no query.");
      if (route.kind === "stripe-webhook") {
        const outcome = await this.services.billing.handleStripeWebhook(
          request.rawBody, controlPlaneHeader(request, "stripe-signature"),
        );
        return response(200, requestId, {
          received: true, duplicate: outcome.duplicate, credited_credits: outcome.creditedCredits,
        });
      }
      const organizationId = route.organizationId;
      if (organizationId === null) throw new Error("Billing route resolution failed.");
      const subject = await this.services.authenticateAccessToken(accessToken(request));
      if (route.kind === "organization-billing") {
        if (request.body !== null) throw new BillingRequestError("GET requests take no body.");
        const billing = await this.services.billing.organizationBilling(subject.userId, organizationId);
        return response(200, requestId, {
          request_id: requestId,
          billing: {
            organization_id: billing.organizationId,
            balance_credits: billing.balanceCredits,
            checkout_enabled: billing.checkoutEnabled,
            prices: billing.prices,
          },
        });
      }
      if (!isJsonControlPlaneRequest(request)) {
        return problem(request, requestId, 415, "BILLING_MEDIA_TYPE_UNSUPPORTED",
          "Unsupported Media Type", "Checkout requests must use application/json.");
      }
      const key = controlPlaneHeader(request, "idempotency-key")?.trim() ?? "";
      if (key.length === 0 || key.length > 200) {
        throw new BillingRequestError("Checkout requires an Idempotency-Key from 1 to 200 characters.");
      }
      const body = checkoutBodySchema.parse(request.body);
      const checkout = await this.services.billing.createCheckout(
        subject.userId, organizationId, body.pack_id, key,
      );
      return response(201, requestId, {
        request_id: requestId,
        checkout_session: {
          id: checkout.id,
          url: checkout.url,
          pack_id: checkout.packId,
          credits: checkout.credits,
          amount: checkout.amount,
          currency: checkout.currency,
        },
      });
    } catch (error) {
      return this.errorResponse(request, requestId, error);
    }
  }

  private errorResponse(
    request: WorkerHttpRequest,
    requestId: string,
    error: unknown,
  ): WorkerHttpResponse {
    if (error instanceof AccessTokenAuthenticationError) {
      return problem(request, requestId, 401, error.code, "Access Token Invalid", error.message);
    }
    if (error instanceof StripeSignatureError) {
      return problem(request, requestId, 400, error.code, "Stripe Signature Invalid", error.message);
    }
    if (error instanceof StripeEventInvalidError || error instanceof BillingRequestError) {
      return problem(request, requestId, 400, error.code, "Billing Request Invalid", error.message);
    }
    if (error instanceof BillingOrganizationNotFoundError) {
      return problem(request, requestId, 404, error.code, "Organization Not Found", error.message);
    }
    if (error instanceof BillingAccessDeniedError) {
      return problem(request, requestId, 403, error.code, "Forbidden", error.message);
    }
    if (error instanceof CreditPackNotFoundError || error instanceof StripeCheckoutMismatchError) {
      return problem(request, requestId, 422, error.code, "Billing Request Unprocessable",
        error.message);
    }
    if (error instanceof ZodError) {
      return problem(request, requestId, 422, "BILLING_REQUEST_INVALID", "Billing Request Invalid",
        "The checkout request body failed validation.");
    }
    if (error instanceof BillingDisabledError) {
      return problem(request, requestId, 503, error.code, "Billing Disabled", error.message);
    }
    if (error instanceof StripeRequestError) {
      return problem(request, requestId, 502, error.code, "Payment Provider Error", error.message);
    }
    return problem(request, requestId, 500, "INTERNAL_ERROR", "Internal Server Error",
      "The billing request could not be completed.");
  }
}
