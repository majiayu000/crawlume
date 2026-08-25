import { ReadError } from "./errors.js";

const MONETARY_PAYMENT_TYPES = new Set([
  "purchase",
  "subscription",
  "training",
  "crawl",
  "use",
  "contribution",
]);
const PAYMENT_TYPES = new Set([...MONETARY_PAYMENT_TYPES, "attribution", "free"]);
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const DECIMAL_AMOUNT = /^(?:0|[1-9][0-9]{0,39})(?:\.[0-9]{1,18})?$/;
const MAX_PAYMENT_PROTOCOLS = 16;

export type RslPaymentQuote = {
  paymentType: string | null;
  paymentAmount: string | null;
  paymentCurrency: string | null;
  paymentProtocols: string[];
  pricingAuthority: "declared" | "runtime" | "unspecified";
};

export type RslPaymentEvaluation = {
  outcome: "permitted" | "confirmation" | "payment";
  obligations: string[];
  quote: RslPaymentQuote | null;
};

function paymentChildren(element: Element, localName: string): Element[] {
  return Array.from(element.children).filter(
    (child) => child.namespaceURI === element.namespaceURI && child.localName === localName,
  );
}

export function rslUrlObligation(kind: "standard" | "terms", value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    throw new ReadError("RSL_INVALID", `The RSL ${kind} obligation must be an absolute HTTP(S) URL.`);
  }
  return `${kind}:${trimmed}`;
}

function parseAmount(payment: Element): { amount: string | null; currency: string | null } {
  const amounts = paymentChildren(payment, "amount");
  if (amounts.length > 1) {
    throw new ReadError("RSL_INVALID", "An RSL payment must not contain multiple amounts.");
  }
  const element = amounts[0];
  if (element === undefined) return { amount: null, currency: null };
  const amount = (element.textContent ?? "").trim();
  const currency = element.getAttribute("currency");
  if (currency === null || !/^[A-Z]{3}$/.test(currency)) {
    throw new ReadError("RSL_INVALID", "An RSL payment currency must be three uppercase letters.");
  }
  if (!DECIMAL_AMOUNT.test(amount) || BigInt(amount.replace(".", "")) === 0n) {
    throw new ReadError(
      "RSL_INVALID",
      "An RSL payment amount must be a positive bounded decimal value.",
    );
  }
  return { amount, currency };
}

function parseProtocols(payment: Element): string[] {
  const elements = paymentChildren(payment, "accepts");
  if (elements.length > MAX_PAYMENT_PROTOCOLS) {
    throw new ReadError("RSL_INVALID", "An RSL payment declares too many protocols.");
  }
  const protocols = elements.map((element) => {
    const type = element.getAttribute("type");
    if (
      type === null ||
      type.length === 0 ||
      type.length > 200 ||
      /[\r\n]/.test(type) ||
      !MEDIA_TYPE.test(type)
    ) {
      throw new ReadError("RSL_INVALID", "An RSL payment protocol must use a valid media type.");
    }
    return type.toLowerCase();
  });
  return [...new Set(protocols)].sort();
}

function validateCustomProcesses(payment: Element): boolean {
  const custom = paymentChildren(payment, "custom");
  for (const element of custom) {
    const value = (element.textContent ?? "").trim();
    if (value.length === 0 || value.length > 2_048 || /[\r\n]/.test(value)) {
      throw new ReadError("RSL_INVALID", "An RSL custom licensing path must be non-empty and bounded.");
    }
    if (value.startsWith("/") && !value.startsWith("//")) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      throw new ReadError(
        "RSL_INVALID",
        "An RSL custom licensing process must be an HTTP(S) URL or absolute path.",
      );
    }
  }
  return custom.length > 0;
}

export function evaluateRslPayment(license: Element): RslPaymentEvaluation {
  const payments = paymentChildren(license, "payment");
  if (payments.length === 0) {
    return { outcome: "permitted", obligations: [], quote: null };
  }
  if (payments.length > 1) {
    throw new ReadError("RSL_INVALID", "An RSL license must not contain multiple payment elements.");
  }
  const payment = payments[0];
  if (payment === undefined) {
    return { outcome: "permitted", obligations: [], quote: null };
  }
  const paymentType = payment.getAttribute("type");
  if (paymentType !== null && !PAYMENT_TYPES.has(paymentType)) {
    throw new ReadError("RSL_INVALID", "The RSL document contains an unsupported payment type.", {
      details: { paymentType },
    });
  }
  const { amount, currency } = parseAmount(payment);
  const protocols = parseProtocols(payment);
  const hasCustom = validateCustomProcesses(payment);
  const obligations: string[] = [];
  if (paymentType === "attribution") obligations.push("attribution");
  for (const standard of paymentChildren(payment, "standard")) {
    obligations.push(rslUrlObligation("standard", standard.textContent ?? ""));
  }

  if (
    paymentType === null ||
    MONETARY_PAYMENT_TYPES.has(paymentType) ||
    amount !== null ||
    protocols.length > 0 ||
    hasCustom
  ) {
    return {
      outcome: "payment",
      obligations: [],
      quote: {
        paymentType,
        paymentAmount: amount,
        paymentCurrency: currency,
        paymentProtocols: protocols,
        pricingAuthority: protocols.length > 0
          ? "runtime"
          : amount !== null
            ? "declared"
            : "unspecified",
      },
    };
  }
  if (obligations.length > 0) {
    return { outcome: "confirmation", obligations, quote: null };
  }
  return { outcome: "permitted", obligations: [], quote: null };
}
