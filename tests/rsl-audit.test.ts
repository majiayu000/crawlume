import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    validation: { outcome: "valid", validatorVersion: "generic-content-v1", checks: [], terminalError: null },
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 1_000,
      contentCharacters: 800,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId: "request-test",
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{
          stageId: "http-read",
          provider: "http",
          reasonCode: "HTTP_PRIMARY",
        }],
        executedStages: ["http-read"],
      },
      rsl: {
        status: "permitted",
        usage: "ai-input",
        discoveredBy: ["robots"],
        licenseUrls: ["https://licenses.example/license.xml?token=secret"],
        licenseHashes: [`sha256:${"a".repeat(64)}`],
        approvalsApplied: 1,
        licenseTokensApplied: 0,
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
        licenseTokensApplied: 0,
        payment: null,
      }),
    ]);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("Sensitive page body");
    expect(serialized).not.toContain("Sensitive title");
    expect(serialized).not.toContain("private-profile");
    expect(serialized).not.toContain("secret");
  });

  it("records a bounded payment quote without settlement data or protocol payloads", () => {
    const audit = new RslAccessAudit(":memory:", "ai-input");
    stores.push(audit);
    audit.recordFailure(
      "https://example.com/paid?key=secret",
      new ReadError("RSL_PAYMENT_REQUIRED", "payment", {
        details: {
          licenseUrl: "https://example.com/license.xml?key=secret",
          paymentType: "crawl",
          paymentAmount: "0.01",
          paymentCurrency: "USD",
          paymentProtocols: "application/x402+json",
          pricingAuthority: "runtime",
          budgetStatus: "disabled",
          settlementStatus: "not-attempted",
          protocolPayload: "do-not-store",
        },
      }),
    );

    const listed = audit.list().entries[0];
    expect(listed).toMatchObject({
      outcome: "failure",
      errorCode: "RSL_PAYMENT_REQUIRED",
      payment: {
        paymentType: "crawl",
        paymentAmount: "0.01",
        paymentCurrency: "USD",
        paymentProtocols: ["application/x402+json"],
        pricingAuthority: "runtime",
        budgetStatus: "disabled",
        settlementStatus: "not-attempted",
      },
    });
    expect(JSON.stringify(listed)).not.toContain("do-not-store");
    expect(JSON.stringify(listed)).not.toContain("secret");
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
    const directory = mkdtempSync(join(tmpdir(), "crawlume-rsl-audit-test-"));
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

  it("migrates the v0.10.2 audit table without losing records", () => {
    const directory = mkdtempSync(join(tmpdir(), "crawlume-rsl-audit-migration-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "audit.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE rsl_access_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        request_url TEXT,
        final_url TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
        error_code TEXT NOT NULL,
        fetch_method TEXT NOT NULL,
        cached INTEGER NOT NULL CHECK(cached IN (0, 1)),
        rsl_status TEXT NOT NULL,
        rsl_usage TEXT NOT NULL,
        license_urls_json TEXT NOT NULL,
        license_hashes_json TEXT NOT NULL,
        approvals_applied INTEGER NOT NULL CHECK(approvals_applied >= 0)
      ) STRICT;
      INSERT INTO rsl_access_audit(
        occurred_at, request_url, final_url, outcome, error_code, fetch_method, cached,
        rsl_status, rsl_usage, license_urls_json, license_hashes_json, approvals_applied
      ) VALUES ('2026-08-25T00:00:00.000Z', NULL, NULL, 'success', '', 'http', 0,
        'not-declared', 'ai-input', '[]', '[]', 0);
    `);
    legacy.close();

    const migrated = new RslAccessAudit(path, "ai-input");
    stores.push(migrated);
    expect(migrated.list().entries).toMatchObject([
      { licenseTokensApplied: 0, payment: null },
    ]);
    migrated.recordSuccess(result());
    expect(migrated.list().entries[0]).toMatchObject({ licenseTokensApplied: 0 });
  });

  it("fails visibly when an audit record cannot be written", () => {
    const audit = new RslAccessAudit(":memory:", "ai-input");
    audit.close();

    expect(() => audit.recordSuccess(result())).toThrow("could not be recorded");
  });
});
