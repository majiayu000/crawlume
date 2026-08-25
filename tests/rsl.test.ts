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
      userAgent: "DiaoyanWebReaderTest/0.1",
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

describe("robots RSL discovery", () => {
  it("uses the most specific matching group and ignores global licenses", () => {
    const robots = `
License: https://example.com/global.xml
User-agent: *
License: https://example.com/default.xml
User-agent: DiaoyanWebReader
Allow: /
License: https://example.com/diaoyan.xml
`;

    expect(parseRobotsLicenseUrls(robots, "DiaoyanWebReader/0.10")).toEqual([
      "https://example.com/diaoyan.xml",
    ]);
  });

  it("falls back to global licenses when the selected group has none", () => {
    const robots = `License: https://example.com/global.xml
User-agent: DiaoyanWebReader
Allow: /`;

    expect(parseRobotsLicenseUrls(robots, "DiaoyanWebReader/0.10")).toEqual([
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
    vi.stubEnv("DIAOYAN_RSL_USAGE", "ai-all");
    expect(() => loadConfig()).toThrow("DIAOYAN_RSL_USAGE must be one of");
  });

  it("requires an uppercase two-letter region", () => {
    vi.stubEnv("DIAOYAN_RSL_GEO", "cn");
    expect(() => loadConfig()).toThrow("DIAOYAN_RSL_GEO must be two uppercase ASCII letters");
  });

  it("requires an absolute administrator approval path", () => {
    vi.stubEnv("DIAOYAN_RSL_APPROVALS_PATH", "relative/approvals.json");
    expect(() => loadConfig()).toThrow("DIAOYAN_RSL_APPROVALS_PATH must be an absolute path");
  });

  it("requires an absolute OLP client path", () => {
    vi.stubEnv("DIAOYAN_RSL_CLIENTS_PATH", "relative/clients.json");
    expect(() => loadConfig()).toThrow("DIAOYAN_RSL_CLIENTS_PATH must be an absolute path");
  });
});
