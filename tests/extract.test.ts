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

  it("preserves code inside presentation-only scroll wrappers", async () => {
    const body = `<html><title>Protocol tools</title><body><article><h1>Protocol tools</h1><p>${"The protocol defines messages and tool results. ".repeat(30)}</p><div class="code-block"><div class="overflow-y-hidden scroll-area"><div><pre language="json"><code>{\n  "method": "tools/list"\n}</code></pre></div></div></div><p>Continue with tool invocation.</p></article></body></html>`;
    const result = await extracted(rawPage({ body }), "article");
    expect(result.markdown).toContain('```json\n{\n  "method": "tools/list"\n}\n```');
    expect(result.markdown).toContain("Continue with tool invocation.");
  });

  it("preserves highlighted line boundaries so comments do not swallow following code", async () => {
    const body = `<html><title>Code guide</title><body><article><p>${"The guide explains working code examples in detail. ".repeat(25)}</p><pre class="language-js"><code><div><span>// Set up the page</span><br></div><div><br></div><div><span>await page.goto('/');</span></div><div><span>await page.close();</span><br></div></code></pre></article></body></html>`;
    const result = await extracted(rawPage({ body }), "article");
    expect(result.markdown).toContain("```js\n// Set up the page\n\nawait page.goto('/');\nawait page.close();\n```");
  });

  it("keeps bare pre content fenced and preserves significant whitespace", async () => {
    const code = 'value = """first  \n\n\n\nlast"""';
    const body = `<html><title>Python guide</title><body><pre>${code}</pre></body></html>`;
    const result = await extracted(rawPage({ body }), "document");
    expect(result.markdown).toBe('```\n' + code + '\n```');
  });

  it("does not split inline hover wrappers or include code-block UI as source", async () => {
    const body = `<html><title>Code</title><body><pre><div>TypeScript</div><code><div><span><div>window<div aria-hidden="true">hover detail</div></div></span>.close();</div><div class="meta-line">type annotation</div></code><a href="/play">Try</a></pre></body></html>`;
    const result = await extracted(rawPage({ body }), "document");
    expect(result.markdown).toBe("```\nwindow.close();\n```\n\n> type annotation");
  });

  it("keeps compiler diagnostics outside the source code without duplicating overlays", async () => {
    const body = `<html><title>Code</title><body><pre><code><div>const count: number = "x";</div><span class="error">Type string is not assignable to number.</span><span class="error-behind">Type string is not assignable to number.</span></code></pre></body></html>`;
    const result = await extracted(rawPage({ body }), "document");
    expect(result.markdown).toBe('```\nconst count: number = "x";\n```\n\n> Type string is not assignable to number.');
  });

  it("does not promote hidden code or discard text next to a code wrapper", async () => {
    const body = `<html><title>Code guide</title><body><article><p>${"The guide explains working code examples in detail. ".repeat(25)}</p><div hidden><pre><code>HIDDEN_SECRET_EXAMPLE</code></pre></div><div>Important explanation.<pre><code>visibleExample();</code></pre></div></article></body></html>`;
    const result = await extracted(rawPage({ body }), "article");
    expect(result.markdown).not.toContain("HIDDEN_SECRET_EXAMPLE");
    expect(result.markdown).toContain("Important explanation.");
    expect(result.markdown).toContain("visibleExample();");
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
