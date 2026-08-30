import { describe, expect, it } from "vitest";

import { normalizeReadRequest } from "../src/reliability/read-intent.js";
import { testConfig } from "./helpers.js";

describe("shared ReadIntent boundary", () => {
  it("applies configured defaults once and produces its plan from the normalized contract", () => {
    const normalized = normalizeReadRequest(
      { ...testConfig(), defaultCacheSeconds: 1_234 },
      new URL("https://example.com/article"),
      { url: "https://example.com/article", requestId: "request-parity" },
      "read",
    );

    expect(normalized).toMatchObject({
      requestId: "request-parity",
      cacheMode: "prefer-cache",
      maxAgeSeconds: 1_234,
      browserAllowed: true,
      authProfile: null,
      intent: {
        url: "https://example.com/article",
        operation: "read",
        output: { format: "markdown" },
        freshness: { maxAgeSeconds: 1_234, allowStaleWhileRevalidate: false },
        authorization: {
          profileId: null,
          allowedOrigins: ["https://example.com"],
        },
        completion: { type: "content" },
      },
      facts: {
        cachePolicy: "prefer-cache",
        providers: { cache: true, http: true, browser: true },
      },
    });
    expect(normalized.plan.id).toMatch(/^plan_[a-f0-9]{64}$/);
    expect(normalizeReadRequest(
      { ...testConfig(), defaultCacheSeconds: 1_234 },
      new URL("https://example.com/article"),
      { url: "https://example.com/article", requestId: "another-request" },
      "read",
    ).plan.id).toBe(normalized.plan.id);
  });

  it("rejects semantic authorization conflicts at the shared boundary", () => {
    expect(() => normalizeReadRequest(
      testConfig(),
      new URL("https://example.com/article"),
      {
        url: "https://example.com/article",
        browserAllowed: false,
        authProfile: "research",
      },
      "read",
    )).toThrow("authProfile requires browser access");
  });
});
