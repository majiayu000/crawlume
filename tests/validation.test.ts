import { describe, expect, it } from "vitest";

import { defaultExtractorRegistry as extractors } from "../src/extract.js";
import type { ExtractedPage, ReadIntent, RawPage } from "../src/types.js";
import {
  defaultValidatorRegistry,
  ValidatorRegistry,
  type CandidateValidator,
} from "../src/validation.js";
import { rawPage } from "./helpers.js";

const intent: ReadIntent = {
  url: "https://example.com/article",
  operation: "read",
  output: { format: "markdown" },
  freshness: { maxAgeSeconds: 900, allowStaleWhileRevalidate: false },
  authorization: { profileId: null, allowedOrigins: ["https://example.com"] },
  completion: { type: "content" },
  budget: {
    deadlineMs: 4_000,
    maxAttempts: 2,
    maxDocumentBytes: 2_000_000,
    maxBrowserMs: 2_000,
    maxBrowserContexts: 1,
    maxOptionalModelTokens: 0,
  },
};

function extracted(overrides: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    title: "Complete page",
    byline: null,
    publishedTime: null,
    markdown: "Complete content ".repeat(50),
    contentCharacters: 850,
    contentHash: "hash",
    extractionMethod: "readability",
    links: [],
    ...overrides,
  };
}

function validate(page: RawPage, candidate: ExtractedPage) {
  return defaultValidatorRegistry.validate({ intent, page, candidate });
}

async function extractDocument(page: RawPage): Promise<ExtractedPage> {
  const batch = await extractors.extract(page);
  const candidate = batch.candidates.find((value) => value.extractorId === "document");
  if (candidate === undefined) throw new Error("missing document candidate");
  return candidate.artifact;
}

describe("ValidatorRegistry", () => {
  it("returns a versioned valid result only after all required checks pass", () => {
    expect(validate(rawPage(), extracted())).toEqual({
      outcome: "valid",
      validatorVersion: "generic-content-v1",
      checks: expect.arrayContaining([
        expect.objectContaining({ code: "CONTENT_MINIMUM", passed: true }),
        expect.objectContaining({ code: "HUMAN_VERIFICATION_REQUIRED", passed: true }),
      ]),
      terminalError: null,
    });
  });

  it("keeps a deliverable short fallback candidate uncertain", () => {
    expect(validate(
      rawPage(),
      extracted({ contentCharacters: 320, extractionMethod: "document" }),
    )).toMatchObject({
      outcome: "uncertain",
      validatorVersion: "generic-content-v1",
      checks: expect.arrayContaining([
        expect.objectContaining({ code: "PREFERRED_CONTENT_LENGTH", passed: false }),
        expect.objectContaining({ code: "PRIMARY_EXTRACTION", passed: false }),
      ]),
      terminalError: null,
    });
  });

  it("classifies a shell candidate as invalid instead of making extraction fail", async () => {
    const body = "<html><body><div id='root'>Loading...</div><script></script><script></script><script></script><script></script></body></html>";
    const page = rawPage({ body, responseBytes: Buffer.byteLength(body) });
    const candidate = await extractDocument(page);

    expect(candidate.markdown).toContain("Loading");
    expect(validate(page, candidate)).toMatchObject({
      outcome: "invalid",
      validatorVersion: "generic-content-v1",
      terminalError: { code: "SHELL_ONLY" },
    });
  });

  it.each([
    [
      "<html><title>Checking your browser</title><body>Verify you are human. CAPTCHA required.</body></html>",
      "HUMAN_VERIFICATION_REQUIRED",
    ],
    [
      "<html><title>Log in</title><body><form><input type='password'></form></body></html>",
      "LOGIN_WALL_DETECTED",
    ],
    [
      "<html><title>Members only</title><body><div class='paywall'>Subscribe to continue.</div></body></html>",
      "PAYMENT_REQUIRED",
    ],
  ])("keeps gate classification in validation", async (body, code) => {
    const page = rawPage({ body, responseBytes: Buffer.byteLength(body) });
    expect(validate(page, await extractDocument(page))).toMatchObject({
      outcome: "invalid",
      terminalError: { code },
    });
  });

  it("records an explicit failed check for a disguised error template", async () => {
    const body = "<html><title>Page not found</title><body>The requested page is unavailable.</body></html>";
    const page = rawPage({ body, responseBytes: Buffer.byteLength(body) });

    expect(validate(page, await extractDocument(page))).toMatchObject({
      outcome: "invalid",
      checks: expect.arrayContaining([
        expect.objectContaining({ code: "ERROR_TEMPLATE", passed: false }),
      ]),
      terminalError: { code: "INCOMPLETE_CONTENT" },
    });
  });

  it("does not claim a generic candidate satisfies a requested schema", () => {
    expect(defaultValidatorRegistry.validate({
      intent: { ...intent, output: { format: "json", schemaId: "article-v1" } },
      page: rawPage(),
      candidate: extracted(),
    })).toMatchObject({
      outcome: "invalid",
      checks: expect.arrayContaining([
        expect.objectContaining({ code: "REQUESTED_SCHEMA", passed: false }),
      ]),
      terminalError: { code: "INCOMPLETE_CONTENT" },
    });
  });

  it("fails visibly when no registered validator supports a candidate", () => {
    const never: CandidateValidator = {
      id: "never",
      version: "never-v1",
      supports: () => false,
      validate: () => {
        throw new Error("must not run");
      },
    };
    expect(() => new ValidatorRegistry([never]).validate({
      intent,
      page: rawPage(),
      candidate: extracted(),
    })).toThrow("No validator supports");
  });
});
