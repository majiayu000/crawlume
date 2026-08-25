import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
import { RslAccessAudit } from "../src/rsl-audit.js";
import type { ReadPageResult } from "../src/types.js";

const stores: RslAccessAudit[] = [];
const temporaryDirectories: string[] = [];

function result(overrides: Partial<ReadPageResult> = {}): ReadPageResult {
  return {
    status: "ok",
    sourceUrl: "https://example.com/article?session=secret",
    finalUrl: "https://example.com/article?session=secret#section",
    fetchedAt: "2026-08-25T00:00:00.000Z",
    fetchMethod: "http",
    authProfile: "private-profile",
    cached: false,
    title: "Sensitive title",
    byline: null,
    publishedTime: null,
    contentMarkdown: "Sensitive page body that must not enter the audit.",
    contentHash: "content-hash",
    completeness: "complete",
    validation: { status: "usable", warnings: [] },
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 1_000,
      contentCharacters: 800,
      extractionMethod: "readability",
      rsl: {
        status: "permitted",
        usage: "ai-input",
        discoveredBy: ["robots"],
        licenseUrls: ["https://licenses.example/license.xml?token=secret"],
        licenseHashes: [`sha256:${"a".repeat(64)}`],
        approvalsApplied: 1,
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RslAccessAudit", () => {
  it("records safe success evidence without content, profiles, or URL queries", () => {
    const audit = new RslAccessAudit(":memory:", "ai-input", () =>
      Date.parse("2026-08-25T12:00:00.000Z"));
    stores.push(audit);
    audit.recordSuccess(result());

    const listed = audit.list(10);
    expect(listed.entries).toEqual([
      expect.objectContaining({
        requestUrl: "https://example.com/article",
        finalUrl: "https://example.com/article",
        outcome: "success",
        fetchMethod: "http",
        cached: false,
        rslStatus: "permitted",
        licenseUrls: ["https://licenses.example/license.xml"],
        licenseHashes: [`sha256:${"a".repeat(64)}`],
        approvalsApplied: 1,
      }),
    ]);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("Sensitive page body");
    expect(serialized).not.toContain("Sensitive title");
    expect(serialized).not.toContain("private-profile");
    expect(serialized).not.toContain("secret");
  });

  it("records RSL and ordinary failures as final outcomes", () => {
    const audit = new RslAccessAudit(":memory:", "ai-input");
    stores.push(audit);
    audit.recordFailure(
      "https://example.com/blocked?key=secret",
      new ReadError("RSL_CONFIRMATION_REQUIRED", "confirmation", {
        details: {
          licenseUrl: "https://example.com/license.xml?key=secret",
          licenseHash: `sha256:${"b".repeat(64)}`,
        },
      }),
    );
    audit.recordFailure(
      "not-a-url",
      new ReadError("INVALID_URL", "invalid"),
    );

    expect(audit.list().entries).toMatchObject([
      { outcome: "failure", errorCode: "INVALID_URL", requestUrl: null, rslStatus: null },
      {
        outcome: "failure",
        errorCode: "RSL_CONFIRMATION_REQUIRED",
        requestUrl: "https://example.com/blocked",
        rslStatus: "blocked",
        licenseUrls: ["https://example.com/license.xml"],
        licenseHashes: [`sha256:${"b".repeat(64)}`],
      },
    ]);
  });

  it("persists records and enforces bounded queries", () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-rsl-audit-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "audit.sqlite");
    const first = new RslAccessAudit(path, "ai-input");
    first.recordSuccess(result({ cached: true }));
    first.close();

    const reopened = new RslAccessAudit(path, "ai-input");
    stores.push(reopened);
    expect(reopened.list(1).entries).toMatchObject([{ cached: true }]);
    expect(() => reopened.list(1_001)).toThrow("between 1 and 1000");
  });

  it("fails visibly when an audit record cannot be written", () => {
    const audit = new RslAccessAudit(":memory:", "ai-input");
    audit.close();

    expect(() => audit.recordSuccess(result())).toThrow("could not be recorded");
  });
});
