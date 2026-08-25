import { describe, expect, it } from "vitest";

import { errorForHttpStatus } from "../src/errors.js";

describe("HTTP error mapping", () => {
  it.each([
    [401, "AUTH_REQUIRED", false],
    [402, "PAYMENT_REQUIRED", false],
    [403, "ACCESS_DENIED", false],
    [429, "RATE_LIMITED", true],
    [500, "UPSTREAM_ERROR", true],
  ] as const)("maps HTTP %i to %s", (status, code, retryable) => {
    expect(errorForHttpStatus(status, "https://example.com/")).toMatchObject({ code, retryable });
  });

  it("does not treat successful responses as errors", () => {
    expect(errorForHttpStatus(200, "https://example.com/")).toBeNull();
  });
});
