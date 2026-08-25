import { describe, expect, it } from "vitest";

import type { ExtractedPage } from "../src/types.js";
import { validateContent } from "../src/validation.js";

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

describe("validateContent", () => {
  it("accepts normal extracted content without extra work", () => {
    expect(validateContent(extracted())).toEqual({ status: "usable", warnings: [] });
  });

  it("marks short fallback extraction as uncertain with stable warning codes", () => {
    expect(
      validateContent(
        extracted({ contentCharacters: 320, extractionMethod: "document" }),
      ),
    ).toEqual({
      status: "uncertain",
      warnings: [
        expect.objectContaining({ code: "SHORT_CONTENT" }),
        expect.objectContaining({ code: "FALLBACK_EXTRACTION" }),
      ],
    });
  });
});
