import { describe, expect, it } from "vitest";

import { defaultExtractorRegistry } from "../src/extract.js";
import type { RawPage } from "../src/types.js";
import { rawPage } from "./helpers.js";

async function extracted(page: RawPage, extractorId: string) {
  const batch = await defaultExtractorRegistry.extract(page);
  const candidate = batch.candidates.find((value) => value.extractorId === extractorId);
  if (candidate === undefined) throw new Error(`missing ${extractorId} candidate`);
  return candidate.artifact;
}

describe("extractPage", () => {
  it("extracts complete article content and sanitizes active content", async () => {
    const paragraph = "Evidence-backed reporting needs enough source context to remain useful after extraction. ";
    const page = rawPage({
      body: `<html><head><title>Reader test</title><script>alert(1)</script></head><body><article><h1>Reader test</h1><p>${paragraph.repeat(6)}</p><a href="javascript:alert(1)" onclick="alert(1)">bad link</a><a href="/source">source</a></article></body></html>`,
    });
    const result = await extracted(page, "article");
    expect(result.title).toContain("Reader test");
    expect(result.markdown).toContain("Evidence-backed reporting");
    expect(result.markdown).toContain("https://example.com/source");
    expect(result.markdown).not.toContain("javascript:");
    expect(result.markdown).not.toContain("alert(1)");
    expect(result.contentCharacters).toBeGreaterThanOrEqual(240);
    expect(result.links).toEqual(["https://example.com/source"]);
  });

  it("returns a candidate for gated HTML so validation owns the terminal decision", async () => {
    const body = "<html><title>App</title><body><div id='root'>Loading...</div><script></script><script></script><script></script><script></script></body></html>";
    await expect(extracted(
      rawPage({ body, responseBytes: Buffer.byteLength(body) }),
      "document",
    )).resolves.toMatchObject({
      title: "App",
      markdown: "Loading...",
    });
  });

  it("extracts sufficiently long plain text", async () => {
    const body = "plain source content ".repeat(20);
    const result = await extracted(rawPage({ body, contentType: "text/plain" }), "plain");
    expect(result.extractionMethod).toBe("plain");
    expect(result.markdown).toBe(body.trim());
  });
});
