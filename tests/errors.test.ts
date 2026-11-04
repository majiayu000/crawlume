import { describe, expect, it } from "vitest";

import { errorForHttpStatus, parseRetryAfterMs } from "../src/errors.js";

describe("HTTP error mapping", () => {
  it.each([
    [401, "AUTH_REQUIRED", false],
    [402, "PAYMENT_REQUIRED", false],
    [403, "ACCESS_DENIED", false],
    [404, "PAGE_NOT_FOUND", false],
    [410, "PAGE_NOT_FOUND", false],
    [405, "ACCESS_DENIED", false],
    [429, "RATE_LIMITED", true],
    [500, "UPSTREAM_ERROR", true],
  ] as const)("maps HTTP %i to %s", (status, code, retryable) => {
    expect(errorForHttpStatus(status, "https://example.com/")).toMatchObject({ code, retryable });
  });

  it("does not treat successful responses as errors", () => {
    expect(errorForHttpStatus(200, "https://example.com/")).toBeNull();
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    expect(parseRetryAfterMs("12", now)).toBe(12_000);
    expect(parseRetryAfterMs("Tue, 25 Aug 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfterMs("invalid", now)).toBeNull();
  });

  it("preserves Retry-After evidence on rate limits", () => {
    expect(errorForHttpStatus(429, "https://example.com/", 2_000)).toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterMs: 2_000 },
    });
  });
});
