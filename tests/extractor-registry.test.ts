import { describe, expect, it } from "vitest";

import {
  defaultExtractorRegistry,
  ExtractorRegistry,
  type CandidateExtractor,
} from "../src/extract.js";
import type { ExtractedPage, RawPage } from "../src/types.js";
import { rawPage } from "./helpers.js";

function minimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/[()\\]/gu, (value) => `\\${value}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "binary"));
}

describe("ExtractorRegistry", () => {
  it("routes declared JSON to a versioned deterministic extractor", async () => {
    const page = rawPage({
      body: JSON.stringify({ title: "Structured evidence", score: 42 }),
      contentType: "application/json",
    });
    const batch = await defaultExtractorRegistry.extract(page);

    expect(batch.candidates).toEqual([
      expect.objectContaining({
        extractorId: "json",
        extractorVersion: "json-v1",
        artifact: expect.objectContaining({
          extractionMethod: "json",
          markdown: expect.stringContaining('"score": 42'),
        }),
      }),
    ]);
  });

  it("runs multiple applicable extractors against the same HTML raw object", async () => {
    const body = `<html><head><title>Registry</title><script type="application/ld+json">${JSON.stringify({
      "@type": "Article",
      headline: "Structured article",
      articleBody: "JSON-LD evidence ".repeat(40),
    })}</script></head><body><article><h1>Registry</h1><p>${"Visible article evidence ".repeat(40)}</p></article></body></html>`;
    const page = rawPage({ body, responseBytes: Buffer.byteLength(body) });
    const batch = await defaultExtractorRegistry.extract(page);

    expect(batch.candidates.map((candidate) => candidate.extractorId)).toEqual([
      "json-ld",
      "article",
    ]);
    expect(batch.attempts.filter((attempt) => attempt.outcome === "candidate")).toHaveLength(2);
  });

  it.each([
    [
      "rss",
      "application/rss+xml",
      "<rss version='2.0'><channel><title>Research feed</title><item><title>Entry one</title><link>https://example.com/one</link><description>Evidence summary</description></item></channel></rss>",
      "https://example.com/one",
    ],
    [
      "atom",
      "application/atom+xml",
      "<feed xmlns='http://www.w3.org/2005/Atom'><title>Research feed</title><entry><title>Entry one</title><link href='https://example.com/one'/><summary>Evidence summary</summary></entry></feed>",
      "https://example.com/one",
    ],
    [
      "sitemap",
      "application/xml",
      "<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'><url><loc>https://example.com/one</loc></url><url><loc>https://example.com/two</loc></url></urlset>",
      "https://example.com/two",
    ],
  ])("routes %s XML without treating it as generic HTML", async (id, contentType, body, link) => {
    const batch = await defaultExtractorRegistry.extract(rawPage({ body, contentType }));
    expect(batch.candidates).toEqual([
      expect.objectContaining({
        extractorId: id,
        artifact: expect.objectContaining({ links: expect.arrayContaining([link]) }),
      }),
    ]);
  });

  it("extracts text from actual PDF bytes", async () => {
    const bodyBytes = minimalPdf("Evidence from a real PDF document");
    const batch = await defaultExtractorRegistry.extract(rawPage({
      body: "",
      bodyBytes,
      contentType: "application/pdf",
      responseBytes: bodyBytes.byteLength,
    }));

    expect(batch.candidates).toEqual([
      expect.objectContaining({
        extractorId: "pdf",
        extractorVersion: "pdfjs-v1",
        artifact: expect.objectContaining({
          extractionMethod: "pdf",
          markdown: expect.stringContaining("Evidence from a real PDF document"),
        }),
      }),
    ]);
  });

  it("passes one raw object to every matching extractor and preserves failures", async () => {
    const seen: RawPage[] = [];
    const artifact: ExtractedPage = {
      title: "candidate",
      byline: null,
      publishedTime: null,
      markdown: "candidate",
      contentCharacters: 9,
      contentHash: "hash",
      extractionMethod: "plain",
      links: [],
    };
    const extractors: CandidateExtractor[] = [
      {
        id: "first",
        version: "first-v1",
        supports: () => true,
        extract: async (page) => {
          seen.push(page);
          return artifact;
        },
      },
      {
        id: "second",
        version: "second-v1",
        supports: () => true,
        extract: async (page) => {
          seen.push(page);
          throw new Error("broken candidate");
        },
      },
    ];
    const page = rawPage();
    const batch = await new ExtractorRegistry(extractors).extract(page);

    expect(seen).toEqual([page, page]);
    expect(batch.candidates).toHaveLength(1);
    expect(batch.attempts).toEqual([
      expect.objectContaining({ extractorId: "first", outcome: "candidate" }),
      expect.objectContaining({ extractorId: "second", outcome: "failed" }),
    ]);
  });

  it("fails visibly when no extractor supports the declared media type", async () => {
    await expect(defaultExtractorRegistry.extract(rawPage({
      body: "binary",
      contentType: "application/octet-stream",
    }))).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT_TYPE" });
  });
});
