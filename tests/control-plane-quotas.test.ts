import { describe, expect, it } from "vitest";

import {
  ApiRequestRateLimiter,
  enforceJobCreationQuotas,
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

  it.each([
    ["2026-10-31T23:59:59.500Z", 1],
    ["2026-11-01T00:00:00.000Z", 2_592_000],
  ])("uses the UTC month reset interval for locked DB time %s", async (timestamp, resetSeconds) => {
    const query = { query: async <Row>() => ({ rows: [{
      active_jobs: "0", reserved_provider_attempts: "2", reserved_browser_ms: "0", artifact_bytes: "0",
    } as Row] }) };
    await expect(enforceJobCreationQuotas(query, "project", { maxProviderAttempts: 2, maxBrowserMs: 0 },
      { ...unlimitedProjectQuotas, monthlyProviderAttempts: 3 }, new Date(timestamp)))
      .rejects.toMatchObject({ quota: "monthlyProviderAttempts", retryAfterSeconds: resetSeconds });
  });

  it("keeps independent limits for more than 10000 current-window keys and rotates them together", () => {
    let now = 60_000;
    const limiter = new ApiRequestRateLimiter(1, () => now);
    for (let key = 0; key < 12_000; key += 1) limiter.take(`key-${key}`);
    expect(() => limiter.take("key-0")).toThrow(expect.objectContaining({ quota: "apiRequestsPerMinute" }));
    expect(() => limiter.take("key-11999")).toThrow(expect.objectContaining({ quota: "apiRequestsPerMinute" }));
    now = 120_000;
    expect(() => limiter.take("key-0")).not.toThrow();
    expect(() => limiter.take("key-11999")).not.toThrow();
    expect(() => limiter.take("key-0")).toThrow(expect.objectContaining({ retryAfterSeconds: 60 }));
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
