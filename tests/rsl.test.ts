import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadError } from "../src/errors.js";
import type { HttpTransport, TransportResponse } from "../src/fetch/http.js";
import { RslPolicy, rslLinksFromHeader } from "../src/rsl.js";
import { parseRobotsLicenseUrls } from "../src/security/robots.js";
import { testConfig } from "./helpers.js";
import { loadConfig } from "../src/config.js";

const namespace = "https://rslstandard.org/rsl";

afterEach(() => {
  vi.unstubAllEnvs();
});

function document(content: string): string {
  return `<rsl xmlns="${namespace}">${content}</rsl>`;
}

function response(
  url: string,
  body: string,
  contentType = "application/rsl+xml",
  linkHeader: string | null = null,
): TransportResponse {
  return {
    url: new URL(url),
    status: 200,
    contentType,
    body,
    responseBytes: Buffer.byteLength(body),
    retryAfterMs: null,
    proxyUsed: false,
    agentIdentity: {
      userAgent: "CrawlumeTest/0.1",
      identityUrl: null,
      signed: false,
      profile: null,
    },
    linkHeader,
  };
}

class StubTransport {
  constructor(private readonly routes: Map<string, TransportResponse>) {}

  async fetch(url: URL): Promise<TransportResponse> {
    const result = this.routes.get(url.toString());
    if (result === undefined) throw new Error("unexpected RSL URL");
    return result;
  }
}

function policy(
  routes: Map<string, TransportResponse> = new Map(),
  config = testConfig(),
): RslPolicy {
  return new RslPolicy(config, new StubTransport(routes) as unknown as HttpTransport);
}

function zipStore(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.concat([local, name, file.data]);
    locals.push(entry);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += entry.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

describe("robots RSL discovery", () => {
  it("uses the most specific matching group and ignores global licenses", () => {
    const robots = `
License: https://example.com/global.xml
User-agent: *
License: https://example.com/default.xml
User-agent: Crawlume
Allow: /
License: https://example.com/crawlume.xml
`;

    expect(parseRobotsLicenseUrls(robots, "Crawlume/0.10")).toEqual([
      "https://example.com/crawlume.xml",
    ]);
  });

  it("falls back to global licenses when the selected group has none", () => {
    const robots = `License: https://example.com/global.xml
User-agent: Crawlume
Allow: /`;

    expect(parseRobotsLicenseUrls(robots, "Crawlume/0.10")).toEqual([
      "https://example.com/global.xml",
    ]);
  });
});

describe("RSL policy", () => {
  it("permits an explicitly free ai-input license", async () => {
    const licenseUrl = "https://example.com/license.xml";
    const xml = document(
      '<content url="/"><license><permits type="usage">ai-input</permits><payment type="free"/></license></content>',
    );
    const result = await policy(new Map([[licenseUrl, response(licenseUrl, xml)]])).evaluateRobots(
      new URL("https://example.com/article"),
      [licenseUrl],
    );

    expect(result).toMatchObject({
      status: "permitted",
      usage: "ai-input",
      discoveredBy: ["robots"],
      licenseUrls: [licenseUrl],
      approvalsApplied: 0,
    });
    expect(result.licenseHashes).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{64}$/)]);
  });

  it("uses the most specific matching content scope", async () => {
    const licenseUrl = "https://example.com/license.xml";
    const xml = document(`
      <content url="/"><license><prohibits type="usage">ai-input</prohibits></license></content>
      <content url="/articles/"><license><permits type="usage">ai-input</permits></license></content>
    `);
    const result = await policy(new Map([[licenseUrl, response(licenseUrl, xml)]])).evaluateRobots(
      new URL("https://example.com/articles/one"),
      [licenseUrl],
    );

    expect(result.status).toBe("permitted");
  });

  it.each([
    ["RSL_PROHIBITED", '<prohibits type="usage">ai-all</prohibits>'],
    ["RSL_LICENSE_REQUIRED", "", ' server="https://licenses.example"'],
    ["RSL_PAYMENT_REQUIRED", '<payment type="crawl"><amount currency="USD">0.01</amount></payment>'],
    ["RSL_CONFIRMATION_REQUIRED", '<payment type="attribution"/>'],
  ])("fails explicitly with %s", async (code, licenseBody, contentAttributes = "") => {
    const licenseUrl = "https://example.com/license.xml";
    const xml = document(
      `<content url="/"${contentAttributes}><license>${licenseBody}</license></content>`,
    );
    const operation = policy(new Map([[licenseUrl, response(licenseUrl, xml)]])).evaluateRobots(
      new URL("https://example.com/article"),
      [licenseUrl],
    );

    await expect(operation).rejects.toMatchObject({
      code: code as ReadError["code"],
    } satisfies Partial<ReadError>);
  });

  it("discovers HTTP Link and inline HTML licenses", async () => {
    const licenseUrl = "https://example.com/header-license.xml";
    const linked = document('<content url="/"><license><permits>ai-input</permits></license></content>');
    const linkedPolicy = policy(new Map([[licenseUrl, response(licenseUrl, linked)]]));
    const page = response(
      "https://example.com/article",
      "<html><body>Article</body></html>",
      "text/html",
      `<${licenseUrl}>; rel="license"; type="application/rsl+xml"`,
    );

    await expect(linkedPolicy.evaluateResponse(page.url, page)).resolves.toMatchObject({
      status: "permitted",
      discoveredBy: ["http-link"],
    });

    const inline = document('<content url=""><license><prohibits>ai-input</prohibits></license></content>');
    const html = response(
      "https://example.com/article",
      `<html><head><script type="application/rsl+xml">${inline}</script></head></html>`,
      "text/html",
    );
    await expect(policy().evaluateResponse(html.url, html)).rejects.toMatchObject({
      code: "RSL_PROHIBITED",
    });
  });

  it("discovers RSL licenses in RSS feeds and applies them to later item URLs", async () => {
    const rsl = policy();
    const feed = response(
      "https://example.com/feed.xml",
      `<rss xmlns:rsl="${namespace}" version="2.0"><channel>
        <item>
          <title>Iris</title>
          <rsl:content url="https://example.com/iris.zip">
            <rsl:license><rsl:payment type="free"/></rsl:license>
          </rsl:content>
        </item>
      </channel></rss>`,
      "application/rss+xml",
    );

    await expect(rsl.evaluateResponse(feed.url, feed)).resolves.toMatchObject({
      status: "not-applicable",
      discoveredBy: ["rss"],
    });

    const item = response(
      "https://example.com/iris.zip",
      "binary",
      "application/zip",
    );
    await expect(rsl.evaluateResponse(item.url, item)).resolves.toMatchObject({
      status: "permitted",
      discoveredBy: ["rss"],
    });
  });

  it("fails closed when an RSS feed contains malformed RSL content", async () => {
    const feed = response(
      "https://example.com/feed.xml",
      `<rss xmlns:rsl="${namespace}" version="2.0"><channel>
        <item><rsl:content url="https://example.com/iris.zip"></rsl:content></item>
      </channel></rss>`,
      "application/rss+xml",
    );

    await expect(policy().evaluateResponse(feed.url, feed)).rejects.toMatchObject({
      code: "RSL_INVALID",
    });
  });

  it("discovers an RSL license embedded in a PDF container", async () => {
    const license = document(
      `<content url="https://example.com/doc.pdf"><license><permits>ai-input</permits></license></content>`,
    );
    const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n"), Buffer.from(license)]);
    const pdf = {
      ...response("https://example.com/doc.pdf", bytes.toString("latin1"), "application/pdf"),
      bodyBytes: new Uint8Array(bytes),
      responseBytes: bytes.byteLength,
    };

    await expect(policy().evaluateResponse(pdf.url, pdf)).resolves.toMatchObject({
      status: "permitted",
      discoveredBy: ["file"],
    });
  });

  it("discovers an RSL license inside a UTF-16 XML file with a byte-order mark", async () => {
    const xml = document(
      `<content url="https://example.com/photo.tif"><license><permits>ai-input</permits></license></content>`,
    );
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
    const image = {
      ...response("https://example.com/photo.tif", bytes.toString("latin1"), "image/tiff"),
      bodyBytes: new Uint8Array(bytes),
      responseBytes: bytes.byteLength,
    };

    await expect(policy().evaluateResponse(image.url, image)).resolves.toMatchObject({
      status: "permitted",
      discoveredBy: ["file"],
    });
  });

  it("discovers an RSL license inside a UTF-16 XMP packet", async () => {
    const inner = document(
      `<content url="https://example.com/photo.jpg"><license><permits>ai-input</permits></license></content>`,
    );
    const packet = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>${inner}<?xpacket end="w"?>`;
    const le = Buffer.from(packet, "utf16le");
    const be = Buffer.alloc(le.length);
    for (let index = 0; index < le.length; index += 2) {
      be[index] = le[index + 1]!;
      be[index + 1] = le[index]!;
    }

    for (const encoded of [le, be]) {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), encoded]);
      const image = {
        ...response("https://example.com/photo.jpg", bytes.toString("latin1"), "image/jpeg"),
        bodyBytes: new Uint8Array(bytes),
        responseBytes: bytes.byteLength,
      };
      await expect(policy().evaluateResponse(image.url, image)).resolves.toMatchObject({
        status: "permitted",
        discoveredBy: ["file"],
      });
    }
  });

  it("fails closed when a JPEG declares unreadable RSL metadata", async () => {
    const bytes = Buffer.from(`fake-jpeg https://rslstandard.org/rsl without a document`);
    const image = {
      ...response("https://example.com/photo.jpg", bytes.toString("latin1"), "image/jpeg"),
      bodyBytes: new Uint8Array(bytes),
      responseBytes: bytes.byteLength,
    };

    await expect(policy().evaluateResponse(image.url, image)).rejects.toMatchObject({
      code: "RSL_INVALID",
    });
  });

  it("discovers an RSL license inside an EPUB OPF", async () => {
    const opf = `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" xmlns:rsl="${namespace}">
        <metadata>
          <rsl:content url="https://example.com/book.epub">
            <rsl:license><rsl:payment type="free"/></rsl:license>
          </rsl:content>
        </metadata>
      </package>`;
    const bytes = zipStore([
      { name: "mimetype", data: Buffer.from("application/epub+zip") },
      { name: "OEBPS/content.opf", data: Buffer.from(opf) },
    ]);
    const epub = {
      ...response("https://example.com/book.epub", bytes.toString("latin1"), "application/epub+zip"),
      bodyBytes: new Uint8Array(bytes),
      responseBytes: bytes.byteLength,
    };

    await expect(policy().evaluateResponse(epub.url, epub)).resolves.toMatchObject({
      status: "permitted",
      discoveredBy: ["file"],
    });
  });

  it("returns not-declared evidence when no association exists", async () => {
    const page = response("https://example.com/article", "<html></html>", "text/html");

    await expect(policy().evaluateResponse(page.url, page)).resolves.toEqual({
      status: "not-declared",
      usage: "ai-input",
      discoveredBy: [],
      licenseUrls: [],
      licenseHashes: [],
      approvalsApplied: 0,
      licenseTokensApplied: 0,
    });
  });

  it("rejects malformed declared RSL instead of silently allowing it", async () => {
    const licenseUrl = "https://example.com/license.xml";
    const malformed = '<rsl xmlns="https://wrong.example"><content/></rsl>';

    await expect(
      policy(new Map([[licenseUrl, response(licenseUrl, malformed)]])).evaluateRobots(
        new URL("https://example.com/article"),
        [licenseUrl],
      ),
    ).rejects.toMatchObject({ code: "RSL_INVALID" });
  });

  it("rejects DTD and entity declarations before XML parsing", async () => {
    const licenseUrl = "https://example.com/license.xml";
    const xml = `<!DOCTYPE rsl [<!ENTITY payload "expanded">]>
      <rsl xmlns="${namespace}"><content url="/"><license><legal>&payload;</legal></license></content></rsl>`;

    await expect(
      policy(new Map([[licenseUrl, response(licenseUrl, xml)]])).evaluateRobots(
        new URL("https://example.com/article"),
        [licenseUrl],
      ),
    ).rejects.toMatchObject({ code: "RSL_INVALID" });
  });

  it("rejects malformed standard-license obligations", async () => {
    const licenseUrl = "https://example.com/license.xml";
    const xml = document(
      '<content url="/"><license><payment type="attribution"><standard>not-a-url</standard></payment></license></content>',
    );

    await expect(
      policy(new Map([[licenseUrl, response(licenseUrl, xml)]])).evaluateRobots(
        new URL("https://example.com/article"),
        [licenseUrl],
      ),
    ).rejects.toMatchObject({ code: "RSL_INVALID" });
  });

  it("returns a structured quote without claiming budget or settlement", async () => {
    const licenseUrl = "https://example.com/license.xml";
    const xml = document(
      '<content url="/"><license><payment type="crawl"><amount currency="USD">0.01</amount><accepts type="application/x402+json">{"scheme":"exact"}</accepts></payment></license></content>',
    );

    await expect(
      policy(new Map([[licenseUrl, response(licenseUrl, xml)]])).evaluateRobots(
        new URL("https://example.com/article"),
        [licenseUrl],
      ),
    ).rejects.toMatchObject({
      code: "RSL_PAYMENT_REQUIRED",
      details: {
        paymentType: "crawl",
        paymentAmount: "0.01",
        paymentCurrency: "USD",
        paymentProtocols: "application/x402+json",
        pricingAuthority: "runtime",
        budgetStatus: "disabled",
        settlementStatus: "not-attempted",
      },
    });
  });
});

describe("RSL Link parsing", () => {
  it("selects only license links with the RSL media type", () => {
    expect(
      rslLinksFromHeader(
        '<https://example.com/next>; rel="next", <https://example.com/license.xml>; rel="alternate license"; type="application/rsl+xml"',
      ),
    ).toEqual(["https://example.com/license.xml"]);
  });
});

describe("RSL configuration", () => {
  it("rejects broad vocabulary tokens as an operator purpose", () => {
    vi.stubEnv("CRAWLUME_RSL_USAGE", "ai-all");
    expect(() => loadConfig()).toThrow("CRAWLUME_RSL_USAGE must be one of");
  });

  it("requires an uppercase two-letter region", () => {
    vi.stubEnv("CRAWLUME_RSL_GEO", "cn");
    expect(() => loadConfig()).toThrow("CRAWLUME_RSL_GEO must be two uppercase ASCII letters");
  });

  it("requires an absolute administrator approval path", () => {
    vi.stubEnv("CRAWLUME_RSL_APPROVALS_PATH", "relative/approvals.json");
    expect(() => loadConfig()).toThrow("CRAWLUME_RSL_APPROVALS_PATH must be an absolute path");
  });

  it("requires an absolute OLP client path", () => {
    vi.stubEnv("CRAWLUME_RSL_CLIENTS_PATH", "relative/clients.json");
    expect(() => loadConfig()).toThrow("CRAWLUME_RSL_CLIENTS_PATH must be an absolute path");
  });
});
