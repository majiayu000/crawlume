import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RslApprovalStore, type RslApprovalContext } from "../src/rsl-approvals.js";
import { RslPolicy } from "../src/rsl.js";
import type { HttpTransport, TransportResponse } from "../src/fetch/http.js";
import { ReadError } from "../src/errors.js";
import { testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "diaoyan-rsl-approval-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "rsl-approvals.json");
}

function context(): RslApprovalContext {
  return {
    licenseHash: `sha256:${"a".repeat(64)}`,
    resource: "/articles/",
    usage: "ai-input",
    userClass: "personal",
    geo: "CN",
    obligations: [
      "attribution",
      "standard:https://creativecommons.org/licenses/by/4.0/",
    ],
  };
}

function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...context(),
    expiresAt: "2099-01-01T00:00:00.000Z",
    approvedBy: "operator@example.com",
    ...overrides,
  };
}

function writeApprovals(path: string, approvals: unknown[], mode = 0o600): void {
  writeFileSync(path, JSON.stringify({ version: 1, approvals }), { mode });
}

class StubTransport {
  constructor(private readonly result: TransportResponse) {}

  async fetch(): Promise<TransportResponse> {
    return this.result;
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RslApprovalStore", () => {
  it("treats a missing administrator file as no approvals", () => {
    const store = new RslApprovalStore(temporaryPath());

    expect(store.has(context())).toBe(false);
    expect(store.contextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches only the complete approved context", () => {
    const path = temporaryPath();
    writeApprovals(path, [approval()]);
    const store = new RslApprovalStore(path);

    expect(store.has(context())).toBe(true);
    expect(store.has({ ...context(), geo: "US" })).toBe(false);
    expect(store.has({ ...context(), resource: "/other/" })).toBe(false);
    expect(store.has({ ...context(), obligations: ["attribution"] })).toBe(false);
  });

  it("stops matching and changes cache context immediately after expiry", () => {
    const path = temporaryPath();
    let now = Date.parse("2026-08-25T00:00:00.000Z");
    writeApprovals(path, [approval({ expiresAt: "2026-08-25T00:01:00.000Z" })]);
    const store = new RslApprovalStore(path, () => now);
    const activeHash = store.contextHash;

    expect(store.has(context())).toBe(true);
    now = Date.parse("2026-08-25T00:01:00.000Z");
    expect(store.has(context())).toBe(false);
    expect(store.contextHash).not.toBe(activeHash);
  });

  it("rejects a file readable by other users", () => {
    const path = temporaryPath();
    writeApprovals(path, [approval()], 0o644);

    expect(() => new RslApprovalStore(path)).toThrow(
      "must not be accessible by group or other users",
    );
  });

  it("rejects expired and duplicate approvals", () => {
    const expiredPath = temporaryPath();
    writeApprovals(expiredPath, [approval({ expiresAt: "2020-01-01T00:00:00.000Z" })]);
    expect(() => new RslApprovalStore(expiredPath)).toThrow("must be a future RFC 3339");

    const duplicatePath = temporaryPath();
    writeApprovals(duplicatePath, [approval(), approval({ approvedBy: "second@example.com" })]);
    expect(() => new RslApprovalStore(duplicatePath)).toThrow("must not contain duplicate approvals");
  });

  it("rejects obligations that confirmation cannot satisfy", () => {
    const path = temporaryPath();
    writeApprovals(path, [approval({ obligations: ["reporting"] })]);

    expect(() => new RslApprovalStore(path)).toThrow(
      "must be unique supported obligations",
    );
  });

  it("lets RSL policy apply an exact attribution approval", async () => {
    const path = temporaryPath();
    const licenseUrl = "https://example.com/license.xml";
    const xml = `<rsl xmlns="https://rslstandard.org/rsl">
      <content url="/"><license><permits>ai-input</permits><payment type="attribution"/></license></content>
    </rsl>`;
    const transportResponse: TransportResponse = {
      url: new URL(licenseUrl),
      status: 200,
      contentType: "application/rsl+xml",
      body: xml,
      responseBytes: Buffer.byteLength(xml),
      retryAfterMs: null,
      proxyUsed: false,
      agentIdentity: {
        userAgent: "DiaoyanWebReaderTest/0.1",
        identityUrl: null,
        signed: false,
        profile: null,
      },
      linkHeader: null,
    };
    const config = { ...testConfig(), rslApprovalsPath: path };
    const transport = new StubTransport(transportResponse) as unknown as HttpTransport;
    let failure: ReadError | null = null;
    try {
      await new RslPolicy(config, transport).evaluateRobots(
        new URL("https://example.com/article"),
        [licenseUrl],
      );
    } catch (error) {
      failure = error as ReadError;
    }
    expect(failure).toMatchObject({
      code: "RSL_CONFIRMATION_REQUIRED",
      details: { resource: "/", obligations: "attribution" },
    });

    writeApprovals(path, [
      {
        licenseHash: failure?.details.licenseHash,
        resource: "/",
        usage: "ai-input",
        userClass: null,
        geo: null,
        obligations: ["attribution"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        approvedBy: "operator@example.com",
      },
    ]);
    const result = await new RslPolicy(config, transport).evaluateRobots(
      new URL("https://example.com/article"),
      [licenseUrl],
    );

    expect(result.status).toBe("permitted");
    expect(result.approvalsApplied).toBe(1);
  });
});
