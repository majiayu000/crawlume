import { describe, expect, it } from "vitest";

import {
  ApiRequestRateLimiter,
  projectQuotasFromEnvironment,
  unlimitedProjectQuotas,
} from "../src/control-plane/quotas.js";

describe("Project quotas", () => {
  it("is unlimited unless configured", () => {
    expect(projectQuotasFromEnvironment({})).toEqual(unlimitedProjectQuotas);
  });

  it("parses every quota and converts browser minutes to milliseconds", () => {
    expect(projectQuotasFromEnvironment({
      DIAOYAN_QUOTA_ACTIVE_JOBS: "5",
      DIAOYAN_QUOTA_MONTHLY_PROVIDER_ATTEMPTS: "100000",
      DIAOYAN_QUOTA_MONTHLY_BROWSER_MINUTES: "600",
      DIAOYAN_QUOTA_ARTIFACT_BYTES: "1073741824",
      DIAOYAN_QUOTA_API_REQUESTS_PER_MINUTE: "120",
    })).toEqual({
      activeJobs: 5,
      monthlyProviderAttempts: 100_000,
      monthlyBrowserMs: 36_000_000,
      artifactBytes: 1_073_741_824,
      apiRequestsPerMinute: 120,
    });
  });

  it.each(["0", "-1", "1.5", "many"])("rejects invalid quota value %s", (value) => {
    expect(() => projectQuotasFromEnvironment({ DIAOYAN_QUOTA_ACTIVE_JOBS: value }))
      .toThrow("DIAOYAN_QUOTA_ACTIVE_JOBS must be a positive integer.");
  });

  it("limits each API key within a fixed minute window", () => {
    let now = 60_000;
    const limiter = new ApiRequestRateLimiter(2, () => now);
    limiter.take("key-a");
    limiter.take("key-a");
    limiter.take("key-b");
    now = 90_000;
    expect(() => limiter.take("key-a")).toThrow(expect.objectContaining({
      code: "QUOTA_EXCEEDED",
      quota: "apiRequestsPerMinute",
      retryAfterSeconds: 30,
    }));
    now = 120_000;
    expect(() => limiter.take("key-a")).not.toThrow();
  });
});
