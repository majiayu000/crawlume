import { describe, expect, it } from "vitest";

import { extractPage } from "../src/extract.js";
import { rawPage } from "./helpers.js";

describe("extractPage", () => {
  it("extracts complete article content and sanitizes active content", () => {
    const paragraph = "Evidence-backed reporting needs enough source context to remain useful after extraction. ";
    const page = rawPage({
      body: `<html><head><title>Reader test</title><script>alert(1)</script></head><body><article><h1>Reader test</h1><p>${paragraph.repeat(6)}</p><a href="javascript:alert(1)" onclick="alert(1)">bad link</a><a href="/source">source</a></article></body></html>`,
    });
    const result = extractPage(page);
    expect(result.title).toContain("Reader test");
    expect(result.markdown).toContain("Evidence-backed reporting");
    expect(result.markdown).toContain("https://example.com/source");
    expect(result.markdown).not.toContain("javascript:");
    expect(result.markdown).not.toContain("alert(1)");
    expect(result.contentCharacters).toBeGreaterThanOrEqual(240);
    expect(result.links).toEqual(["https://example.com/source"]);
  });

  it.each([
    ["<html><title>Checking your browser</title><body>Verify you are human. CAPTCHA required.</body></html>", "HUMAN_VERIFICATION_REQUIRED"],
    ["<html><title>Log in</title><body>Log in or sign up to continue reading.</body></html>", "LOGIN_WALL_DETECTED"],
    ["<html><title>App</title><body><div id='root'>Loading...</div><script></script><script></script><script></script><script></script></body></html>", "SHELL_ONLY"],
  ])("fails visibly on gate or shell pages", (body, code) => {
    expect(() => extractPage(rawPage({ body, responseBytes: Buffer.byteLength(body) }))).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("extracts sufficiently long plain text", () => {
    const body = "plain source content ".repeat(20);
    const result = extractPage(rawPage({ body, contentType: "text/plain" }));
    expect(result.extractionMethod).toBe("plain");
    expect(result.markdown).toBe(body.trim());
  });
});
