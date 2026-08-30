import { ReadError } from "../errors.js";
import type { CrawlBudget, CrawlResourceUsage, ExecutionBudget } from "../types.js";

type GovernedDimension = {
  budget: Exclude<keyof CrawlBudget, "maxDurationMs">;
  usage: keyof Pick<
    CrawlResourceUsage,
    "providerAttempts" | "documentBytesIn" | "browserMilliseconds" | "browserContextStarts"
  >;
  requested: keyof Pick<
    ExecutionBudget,
    "maxAttempts" | "maxDocumentBytes" | "maxBrowserMs" | "maxBrowserContexts"
  >;
};

const governedDimensions: readonly GovernedDimension[] = [
  {
    budget: "maxProviderAttempts",
    usage: "providerAttempts",
    requested: "maxAttempts",
  },
  {
    budget: "maxDocumentBytes",
    usage: "documentBytesIn",
    requested: "maxDocumentBytes",
  },
  {
    budget: "maxBrowserMs",
    usage: "browserMilliseconds",
    requested: "maxBrowserMs",
  },
  {
    budget: "maxBrowserContexts",
    usage: "browserContextStarts",
    requested: "maxBrowserContexts",
  },
];

const usageFields: readonly (keyof CrawlResourceUsage)[] = [
  "providerAttempts",
  "documentBytesIn",
  "networkBytesOut",
  "browserMilliseconds",
  "browserContextStarts",
  "retryDelayMilliseconds",
  "optionalModelTokens",
];

export type CrawlReservationResult = {
  budgetSlice: ExecutionBudget;
  reservation: CrawlResourceUsage;
  reserved: CrawlResourceUsage;
};

export type CrawlSettlementResult = {
  usage: CrawlResourceUsage;
  reserved: CrawlResourceUsage;
};

function invalidArgument(message: string, details: Record<string, number | string> = {}): never {
  throw new ReadError("INVALID_ARGUMENT", message, { details });
}

function budgetExhausted(dimension: keyof CrawlBudget, limit: number, actual: number): never {
  throw new ReadError("BUDGET_EXHAUSTED", `The crawl exhausted its ${dimension} budget.`, {
    details: { budgetDimension: dimension, budgetLimit: limit, budgetActual: actual },
  });
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidArgument(`${field} must be a non-negative safe integer.`, { field, value });
  }
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalidArgument(`${field} must be a positive safe integer.`, { field, value });
  }
}

function checkedAdd(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    invalidArgument(`${field} exceeds the safe integer range.`, { field });
  }
  return sum;
}

function validateCrawlBudget(budget: CrawlBudget): void {
  requirePositiveSafeInteger(budget.maxDurationMs, "budget.maxDurationMs");
  requirePositiveSafeInteger(budget.maxProviderAttempts, "budget.maxProviderAttempts");
  requireNonNegativeSafeInteger(budget.maxDocumentBytes, "budget.maxDocumentBytes");
  requireNonNegativeSafeInteger(budget.maxBrowserMs, "budget.maxBrowserMs");
  requireNonNegativeSafeInteger(budget.maxBrowserContexts, "budget.maxBrowserContexts");
}

function validateExecutionBudget(budget: ExecutionBudget): void {
  requirePositiveSafeInteger(budget.deadlineMs, "requested.deadlineMs");
  requirePositiveSafeInteger(budget.maxAttempts, "requested.maxAttempts");
  requireNonNegativeSafeInteger(budget.maxDocumentBytes, "requested.maxDocumentBytes");
  requireNonNegativeSafeInteger(budget.maxBrowserMs, "requested.maxBrowserMs");
  requireNonNegativeSafeInteger(budget.maxBrowserContexts, "requested.maxBrowserContexts");
  requireNonNegativeSafeInteger(
    budget.maxOptionalModelTokens,
    "requested.maxOptionalModelTokens",
  );
}

function validateUsage(value: CrawlResourceUsage, field: string): void {
  for (const usageField of usageFields) {
    requireNonNegativeSafeInteger(value[usageField], `${field}.${usageField}`);
  }
}

function validateCurrentState(
  budget: CrawlBudget,
  usage: CrawlResourceUsage,
  reserved: CrawlResourceUsage,
): void {
  validateCrawlBudget(budget);
  validateUsage(usage, "usage");
  validateUsage(reserved, "reserved");
  for (const dimension of governedDimensions) {
    const committedAndReserved = checkedAdd(
      usage[dimension.usage],
      reserved[dimension.usage],
      dimension.usage,
    );
    if (committedAndReserved > budget[dimension.budget]) {
      invalidArgument("Committed and reserved crawl usage exceeds its persisted budget.", {
        budgetDimension: dimension.budget,
        budgetLimit: budget[dimension.budget],
        budgetActual: committedAndReserved,
      });
    }
  }
}

function addUsage(
  left: CrawlResourceUsage,
  right: CrawlResourceUsage,
  field: string,
): CrawlResourceUsage {
  return {
    providerAttempts: checkedAdd(left.providerAttempts, right.providerAttempts, field),
    documentBytesIn: checkedAdd(left.documentBytesIn, right.documentBytesIn, field),
    networkBytesOut: checkedAdd(left.networkBytesOut, right.networkBytesOut, field),
    browserMilliseconds: checkedAdd(
      left.browserMilliseconds,
      right.browserMilliseconds,
      field,
    ),
    browserContextStarts: checkedAdd(
      left.browserContextStarts,
      right.browserContextStarts,
      field,
    ),
    retryDelayMilliseconds: checkedAdd(
      left.retryDelayMilliseconds,
      right.retryDelayMilliseconds,
      field,
    ),
    optionalModelTokens: checkedAdd(left.optionalModelTokens, right.optionalModelTokens, field),
  };
}

export function emptyCrawlResourceUsage(): CrawlResourceUsage {
  return {
    providerAttempts: 0,
    documentBytesIn: 0,
    networkBytesOut: 0,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryDelayMilliseconds: 0,
    optionalModelTokens: 0,
  };
}

export function remainingCrawlResources(input: {
  budget: CrawlBudget;
  usage: CrawlResourceUsage;
  reserved: CrawlResourceUsage;
  elapsedMs: number;
}): CrawlBudget {
  validateCurrentState(input.budget, input.usage, input.reserved);
  requireNonNegativeSafeInteger(input.elapsedMs, "elapsedMs");

  return {
    maxDurationMs: Math.max(0, input.budget.maxDurationMs - input.elapsedMs),
    maxProviderAttempts: input.budget.maxProviderAttempts
      - input.usage.providerAttempts
      - input.reserved.providerAttempts,
    maxDocumentBytes: input.budget.maxDocumentBytes
      - input.usage.documentBytesIn
      - input.reserved.documentBytesIn,
    maxBrowserMs: input.budget.maxBrowserMs
      - input.usage.browserMilliseconds
      - input.reserved.browserMilliseconds,
    maxBrowserContexts: input.budget.maxBrowserContexts
      - input.usage.browserContextStarts
      - input.reserved.browserContextStarts,
  };
}

export function reserveCrawlResources(input: {
  budget: CrawlBudget;
  usage: CrawlResourceUsage;
  reserved: CrawlResourceUsage;
  requested: ExecutionBudget;
  elapsedMs: number;
}): CrawlReservationResult {
  validateExecutionBudget(input.requested);
  const remaining = remainingCrawlResources(input);
  if (remaining.maxDurationMs === 0) {
    budgetExhausted("maxDurationMs", input.budget.maxDurationMs, input.elapsedMs);
  }

  for (const dimension of governedDimensions) {
    if (input.requested[dimension.requested] > 0 && remaining[dimension.budget] === 0) {
      budgetExhausted(
        dimension.budget,
        input.budget[dimension.budget],
        input.usage[dimension.usage] + input.reserved[dimension.usage],
      );
    }
  }

  const budgetSlice: ExecutionBudget = {
    deadlineMs: Math.min(input.requested.deadlineMs, remaining.maxDurationMs),
    maxAttempts: Math.min(input.requested.maxAttempts, remaining.maxProviderAttempts),
    maxDocumentBytes: Math.min(
      input.requested.maxDocumentBytes,
      remaining.maxDocumentBytes,
    ),
    maxBrowserMs: Math.min(input.requested.maxBrowserMs, remaining.maxBrowserMs),
    maxBrowserContexts: Math.min(
      input.requested.maxBrowserContexts,
      remaining.maxBrowserContexts,
    ),
    maxOptionalModelTokens: input.requested.maxOptionalModelTokens,
  };
  const reservation = emptyCrawlResourceUsage();
  reservation.providerAttempts = budgetSlice.maxAttempts;
  reservation.documentBytesIn = budgetSlice.maxDocumentBytes;
  reservation.browserMilliseconds = budgetSlice.maxBrowserMs;
  reservation.browserContextStarts = budgetSlice.maxBrowserContexts;

  return {
    budgetSlice,
    reservation,
    reserved: addUsage(input.reserved, reservation, "reserved"),
  };
}

export function settleCrawlResources(input: {
  budget: CrawlBudget;
  usage: CrawlResourceUsage;
  reserved: CrawlResourceUsage;
  reservation: CrawlResourceUsage;
  actual: CrawlResourceUsage;
}): CrawlSettlementResult {
  validateCurrentState(input.budget, input.usage, input.reserved);
  validateUsage(input.reservation, "reservation");
  validateUsage(input.actual, "actual");

  for (const dimension of governedDimensions) {
    const reservedForPage = input.reservation[dimension.usage];
    if (input.reserved[dimension.usage] < reservedForPage) {
      invalidArgument("The page reservation is not present in the crawl reserved usage.", {
        budgetDimension: dimension.budget,
        reservedAvailable: input.reserved[dimension.usage],
        reservationRequested: reservedForPage,
      });
    }
    if (input.actual[dimension.usage] > reservedForPage) {
      budgetExhausted(
        dimension.budget,
        reservedForPage,
        input.actual[dimension.usage],
      );
    }
  }

  const reserved: CrawlResourceUsage = {
    providerAttempts: input.reserved.providerAttempts - input.reservation.providerAttempts,
    documentBytesIn: input.reserved.documentBytesIn - input.reservation.documentBytesIn,
    networkBytesOut: input.reserved.networkBytesOut - input.reservation.networkBytesOut,
    browserMilliseconds:
      input.reserved.browserMilliseconds - input.reservation.browserMilliseconds,
    browserContextStarts:
      input.reserved.browserContextStarts - input.reservation.browserContextStarts,
    retryDelayMilliseconds:
      input.reserved.retryDelayMilliseconds - input.reservation.retryDelayMilliseconds,
    optionalModelTokens:
      input.reserved.optionalModelTokens - input.reservation.optionalModelTokens,
  };
  validateUsage(reserved, "reserved");

  const usage = addUsage(input.usage, input.actual, "usage");
  validateCurrentState(input.budget, usage, reserved);
  return { usage, reserved };
}
