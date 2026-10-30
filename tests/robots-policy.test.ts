import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { ReadError } from "../src/errors.js";
import type { HttpTransport } from "../src/fetch/http.js";
import { RobotsPolicy } from "../src/security/robots.js";

const config = { robotsCacheSeconds: 60, userAgent: "crawlume-test" } as AppConfig;
const pageUrl = new URL("https://example.test/private/page");

function policy(status: number, contentType: string, body: string): RobotsPolicy {
  const transport = {
    fetch: async (url: URL) => ({ status, url, contentType, body }),
  } as unknown as HttpTransport;
  return new RobotsPolicy(config, transport);
}

describe("RobotsPolicy rule document validation", () => {
  it.each([
    ["HTML soft 404", "text/html; charset=utf-8", "<!doctype html><title>Not found</title>"],
    ["JSON error", "application/json", '{"error":"not found"}'],
    ["HTML labelled text/plain", "text/plain", "\n  <html><body>Challenge</body></html>"],
    ["JSON labelled text/plain", "text/plain", '[{"error":"blocked"}]'],
    ["HTML without a Content-Type", "", "<html><body>Sorry</body></html>"],
    ["unexpected media type", "application/octet-stream", "User-agent: *\nDisallow:"],
  ])("fails closed for %s", async (_name, contentType, body) => {
    const denied = await policy(200, contentType, body).assertAllowed(pageUrl).catch((error) => error);

    expect(denied).toBeInstanceOf(ReadError);
    expect(denied).toMatchObject({ code: "ROBOTS_UNAVAILABLE", retryable: false });
  });

  it("does not read licenses from a document that is not a rule file", async () => {
    await expect(policy(200, "text/html", "<html></html>").licenseUrls(pageUrl))
      .rejects.toMatchObject({ code: "ROBOTS_UNAVAILABLE" });
  });

  it.each([
    ["text/plain", "text/plain", "User-agent: *\nDisallow: /other"],
    ["case-insensitive parameters", "Text/Plain; Charset=UTF-8", "User-agent: *\nDisallow: /other"],
    ["a missing Content-Type", "", "User-agent: *\nDisallow: /other"],
    ["a byte order mark", "text/plain", "﻿User-agent: *\nDisallow: /other"],
    ["an empty rule file", "text/plain", ""],
  ])("accepts %s", async (_name, contentType, body) => {
    await expect(policy(200, contentType, body).assertAllowed(pageUrl)).resolves.toBeUndefined();
  });

  it("still enforces rules from a valid document", async () => {
    await expect(policy(200, "text/plain", "User-agent: *\nDisallow: /private").assertAllowed(pageUrl))
      .rejects.toMatchObject({ code: "ROBOTS_DISALLOWED" });
  });

  it("still treats 404 as no rule file", async () => {
    await expect(policy(404, "text/html", "<html></html>").assertAllowed(pageUrl)).resolves.toBeUndefined();
  });
});
