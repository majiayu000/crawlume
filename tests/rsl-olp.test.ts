import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
import type { FormResponse, HttpTransport, TransportResponse } from "../src/fetch/http.js";
import { HttpPageFetcher } from "../src/fetch/http.js";
import { RslClientCredentialStore } from "../src/rsl-client-credentials.js";
import { RslOlpClient } from "../src/rsl-olp.js";
import { RslPolicy } from "../src/rsl.js";
import type { RobotsPolicy } from "../src/security/robots.js";
import { testConfig } from "./helpers.js";

const namespace = "https://rslstandard.org/rsl";
const temporaryDirectories: string[] = [];

function clientsFile(
  clients: Array<{ server: string; clientId: string; clientSecret: string }>,
  mode = 0o600,
): string {
  const directory = mkdtempSync(join(tmpdir(), "diaoyan-rsl-clients-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "clients.json");
  writeFileSync(path, JSON.stringify({ version: 1, clients }), { mode });
  return path;
}

function transportResponse(
  url: string,
  status: number,
  body: string,
  contentType: string,
): TransportResponse {
  return {
    url: new URL(url),
    status,
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
    linkHeader: null,
  };
}

class TokenTransport {
  calls: Array<{
    url: string;
    form: URLSearchParams;
    authorization: string;
    maxBytes: number;
  }> = [];

  constructor(private readonly responses: FormResponse[]) {}

  async postForm(
    url: URL,
    form: URLSearchParams,
    authorization: string,
    maxBytes: number,
  ): Promise<FormResponse> {
    this.calls.push({ url: url.toString(), form, authorization, maxBytes });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("token response exhausted");
    return response;
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RSL client credentials", () => {
  it("normalizes exact HTTPS servers and rejects broadly readable files", () => {
    const safePath = clientsFile([
      { server: "https://licenses.example/v1/", clientId: "client", clientSecret: "secret" },
    ]);
    expect(new RslClientCredentialStore(safePath).get("https://licenses.example/v1")).toMatchObject({
      server: "https://licenses.example/v1",
      clientId: "client",
    });

    const unsafePath = clientsFile([], 0o644);
    expect(() => new RslClientCredentialStore(unsafePath)).toThrow(
      "must not be accessible by group or other users",
    );
  });

  it.each([
    "http://licenses.example",
    "https://user:secret@licenses.example",
    "https://licenses.example?token=secret",
  ])("rejects unsafe License Server URL %s", (server) => {
    const path = clientsFile([{ server, clientId: "client", clientSecret: "secret" }]);
    expect(() => new RslClientCredentialStore(path)).toThrow("must be HTTPS");
  });
});

describe("RslOlpClient", () => {
  it("form-encodes Basic credentials, coalesces requests, and caches opaque tokens", async () => {
    const path = clientsFile([
      { server: "https://licenses.example/api", clientId: "client:id", clientSecret: "s ecret" },
    ]);
    const transport = new TokenTransport([
      {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ access_token: "opaque-token", token_type: "License", expires_in: 60 }),
      },
    ]);
    const client = new RslOlpClient(path, transport as unknown as HttpTransport);
    const request = {
      server: "https://licenses.example/api",
      licenseHash: `sha256:${"a".repeat(64)}`,
      licenseXml: '<license xmlns="https://rslstandard.org/rsl"><permits>ai-input</permits></license>',
      resource: "/articles/",
    };

    const [first, second] = await Promise.all([client.acquire(request), client.acquire(request)]);
    expect(first).toBe("License opaque-token");
    expect(second).toBe(first);
    expect(await client.acquire(request)).toBe(first);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe("https://licenses.example/api/token");
    expect(transport.calls[0]?.form.get("grant_type")).toBe("client_credentials");
    expect(transport.calls[0]?.form.get("license")).toBe(request.licenseXml);
    expect(transport.calls[0]?.form.get("license_type")).toBe("application/rsl+xml");
    expect(transport.calls[0]?.form.get("resource")).toBe("/articles/");
    expect(Buffer.from(
      transport.calls[0]?.authorization.replace(/^Basic /, "") ?? "",
      "base64",
    ).toString("utf8")).toBe("client%3Aid:s+ecret");
  });

  it("expires finite tokens and never exposes server response secrets in errors", async () => {
    const path = clientsFile([
      { server: "https://licenses.example", clientId: "client", clientSecret: "secret" },
    ]);
    let now = 1_000;
    const transport = new TokenTransport([
      {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: "first", token_type: "License", expires_in: 10 }),
      },
      {
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_client", error_description: "do-not-leak-secret" }),
      },
    ]);
    const client = new RslOlpClient(path, transport as unknown as HttpTransport, () => now);
    const request = {
      server: "https://licenses.example",
      licenseHash: `sha256:${"b".repeat(64)}`,
      licenseXml: "<license/>",
      resource: "/",
    };

    await expect(client.acquire(request)).resolves.toBe("License first");
    now = 11_000;
    const error = await client.acquire(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RSL_LICENSE_REQUIRED", retryable: false });
    expect(JSON.stringify(error)).not.toContain("do-not-leak-secret");
    expect(JSON.stringify(error)).not.toContain("clientSecret");
  });

  it("rejects unsafe token lifetimes instead of treating overflow as non-expiring", async () => {
    const path = clientsFile([
      { server: "https://licenses.example", clientId: "client", clientSecret: "secret" },
    ]);
    const transport = new TokenTransport([{
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "token",
        token_type: "License",
        expires_in: Number.MAX_SAFE_INTEGER,
      }),
    }]);
    const client = new RslOlpClient(path, transport as unknown as HttpTransport);

    await expect(client.acquire({
      server: "https://licenses.example",
      licenseHash: `sha256:${"c".repeat(64)}`,
      licenseXml: "<license/>",
      resource: "/",
    })).rejects.toMatchObject({ code: "RSL_LICENSE_REQUIRED" });
  });
});

describe("RSL OLP and CAP integration", () => {
  it("refreshes a presented token after a bounded 401 challenge", async () => {
    const path = clientsFile([
      { server: "https://licenses.example", clientId: "client", clientSecret: "secret" },
    ]);
    const transport = new TokenTransport([
      {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: "first-token", token_type: "License", expires_in: 60 }),
      },
      {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: "second-token", token_type: "License", expires_in: 60 }),
      },
    ]);
    const config = { ...testConfig(), rslClientsPath: path };
    const policy = new RslPolicy(config, transport as unknown as HttpTransport);
    const pageUrl = "https://publisher.example/article";
    const rsl = `<rsl xmlns="${namespace}"><content url="/article" server="https://licenses.example"><license><permits>ai-input</permits></license></content></rsl>`;
    const challenge = transportResponse(pageUrl, 401, rsl, "application/rsl+xml");

    const first = await policy.authorizeResponse(new URL(pageUrl), challenge, true);
    const refreshed = await policy.authorizeResponse(
      new URL(pageUrl),
      challenge,
      true,
      first.authorization,
      true,
    );

    expect(first.authorization).toBe("License first-token");
    expect(refreshed.authorization).toBe("License second-token");
    expect(refreshed.evidence.licenseTokensApplied).toBe(0);
    expect(transport.calls).toHaveLength(2);
  });

  it("acquires a free declared license and retries an inline CAP challenge once", async () => {
    const path = clientsFile([
      { server: "https://licenses.example", clientId: "client", clientSecret: "secret" },
    ]);
    const rsl = `<rsl xmlns="${namespace}"><content url="/article" server="https://licenses.example"><license><permits>ai-input</permits><payment type="free"/></license></content></rsl>`;
    const pageUrl = "https://publisher.example/article";
    const pages = [
      transportResponse(pageUrl, 401, rsl, "application/rsl+xml"),
      transportResponse(pageUrl, 200, "<html><body>Licensed article</body></html>", "text/html"),
    ];
    const presented: Array<string | null> = [];
    const transport = {
      async fetch(
        url: URL,
        options: { beforeRequest?: (target: URL) => Promise<{ authorization: string } | void> },
      ): Promise<TransportResponse> {
        const access = await options.beforeRequest?.(url);
        presented.push(access?.authorization ?? null);
        const response = pages.shift();
        if (response === undefined) throw new Error("page response exhausted");
        return response;
      },
      async postForm(): Promise<FormResponse> {
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ access_token: "cap-token", token_type: "License", expires_in: 60 }),
        };
      },
    };
    const config = { ...testConfig(), rslClientsPath: path };
    const policy = new RslPolicy(config, transport as unknown as HttpTransport);
    const robots = {
      async assertAllowed(): Promise<void> {},
      async licenseUrls(): Promise<string[]> { return []; },
    };
    const fetcher = new HttpPageFetcher(
      transport as unknown as HttpTransport,
      robots as unknown as RobotsPolicy,
      policy,
    );

    const result = await fetcher.fetch(new URL(pageUrl));

    expect(presented).toEqual([null, "License cap-token"]);
    expect(result.httpStatus).toBe(200);
    expect(result.rsl).toMatchObject({
      status: "permitted",
      licenseTokensApplied: 1,
    });
    expect(pages).toEqual([]);
  });

  it("never requests a token for a paid server license", async () => {
    const path = clientsFile([
      { server: "https://licenses.example", clientId: "client", clientSecret: "secret" },
    ]);
    let tokenRequests = 0;
    const licenseUrl = "https://publisher.example/license.xml";
    const xml = `<rsl xmlns="${namespace}"><content url="/" server="https://licenses.example"><license><permits>ai-input</permits><payment type="purchase"><amount currency="USD">1</amount></payment></license></content></rsl>`;
    const transport = {
      async fetch(): Promise<TransportResponse> {
        return transportResponse(licenseUrl, 200, xml, "application/rsl+xml");
      },
      async postForm(): Promise<FormResponse> {
        tokenRequests += 1;
        throw new Error("must not request a token");
      },
    };
    const policy = new RslPolicy(
      { ...testConfig(), rslClientsPath: path },
      transport as unknown as HttpTransport,
    );

    await expect(policy.authorizeRobots(
      new URL("https://publisher.example/article"),
      [licenseUrl],
    )).rejects.toMatchObject({ code: "RSL_PAYMENT_REQUIRED" } satisfies Partial<ReadError>);
    expect(tokenRequests).toBe(0);
  });

  it("evaluates every applicable license before making any token request", async () => {
    const path = clientsFile([
      { server: "https://licenses.example", clientId: "client", clientSecret: "secret" },
    ]);
    let tokenRequests = 0;
    const licenseUrl = "https://publisher.example/license.xml";
    const xml = `<rsl xmlns="${namespace}"><content url="/" server="https://licenses.example">
      <license><permits>ai-input</permits><payment type="free"/></license>
      <license><prohibits>ai-input</prohibits></license>
    </content></rsl>`;
    const transport = {
      async fetch(): Promise<TransportResponse> {
        return transportResponse(licenseUrl, 200, xml, "application/rsl+xml");
      },
      async postForm(): Promise<FormResponse> {
        tokenRequests += 1;
        throw new Error("must not request a token");
      },
    };
    const policy = new RslPolicy(
      { ...testConfig(), rslClientsPath: path },
      transport as unknown as HttpTransport,
    );

    await expect(policy.authorizeRobots(
      new URL("https://publisher.example/article"),
      [licenseUrl],
    )).rejects.toMatchObject({ code: "RSL_PROHIBITED" } satisfies Partial<ReadError>);
    expect(tokenRequests).toBe(0);
  });

  it("does not acquire from a non-CAP 403 response", async () => {
    const path = clientsFile([
      { server: "https://licenses.example", clientId: "client", clientSecret: "secret" },
    ]);
    const pageUrl = "https://publisher.example/article";
    const rsl = `<rsl xmlns="${namespace}"><content url="/article" server="https://licenses.example"><license><permits>ai-input</permits></license></content></rsl>`;
    let tokenRequests = 0;
    const transport = {
      async fetch(
        url: URL,
        options: { beforeRequest?: (target: URL) => Promise<{ authorization: string } | void> },
      ): Promise<TransportResponse> {
        await options.beforeRequest?.(url);
        return transportResponse(pageUrl, 403, rsl, "application/rsl+xml");
      },
      async postForm(): Promise<FormResponse> {
        tokenRequests += 1;
        throw new Error("must not request a token");
      },
    };
    const policy = new RslPolicy(
      { ...testConfig(), rslClientsPath: path },
      transport as unknown as HttpTransport,
    );
    const robots = {
      async assertAllowed(): Promise<void> {},
      async licenseUrls(): Promise<string[]> { return []; },
    };
    const fetcher = new HttpPageFetcher(
      transport as unknown as HttpTransport,
      robots as unknown as RobotsPolicy,
      policy,
    );

    await expect(fetcher.fetch(new URL(pageUrl))).rejects.toMatchObject({
      code: "RSL_LICENSE_REQUIRED",
    });
    expect(tokenRequests).toBe(0);
  });

  it("does not forward a challenge token across a redirect target", async () => {
    const path = clientsFile([
      { server: "https://licenses.example", clientId: "client", clientSecret: "secret" },
    ]);
    const pageUrl = "https://publisher.example/article";
    const redirectedUrl = "https://other.example/article";
    const rsl = `<rsl xmlns="${namespace}"><content url="/article" server="https://licenses.example"><license><permits>ai-input</permits></license></content></rsl>`;
    const presented: Array<[string, string | null]> = [];
    let attempt = 0;
    const transport = {
      async fetch(
        url: URL,
        options: { beforeRequest?: (target: URL) => Promise<{ authorization: string } | void> },
      ): Promise<TransportResponse> {
        const first = await options.beforeRequest?.(url);
        presented.push([url.toString(), first?.authorization ?? null]);
        if (attempt === 0) {
          attempt += 1;
          return transportResponse(pageUrl, 401, rsl, "application/rsl+xml");
        }
        const redirected = new URL(redirectedUrl);
        const second = await options.beforeRequest?.(redirected);
        presented.push([redirected.toString(), second?.authorization ?? null]);
        return transportResponse(redirectedUrl, 200, "<html><body>Redirected</body></html>", "text/html");
      },
      async postForm(): Promise<FormResponse> {
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ access_token: "cap-token", token_type: "License", expires_in: 60 }),
        };
      },
    };
    const policy = new RslPolicy(
      { ...testConfig(), rslClientsPath: path },
      transport as unknown as HttpTransport,
    );
    const robots = {
      async assertAllowed(): Promise<void> {},
      async licenseUrls(): Promise<string[]> { return []; },
    };
    const fetcher = new HttpPageFetcher(
      transport as unknown as HttpTransport,
      robots as unknown as RobotsPolicy,
      policy,
    );

    await expect(fetcher.fetch(new URL(pageUrl))).resolves.toMatchObject({
      finalUrl: redirectedUrl,
    });
    expect(presented).toEqual([
      [pageUrl, null],
      [pageUrl, "License cap-token"],
      [redirectedUrl, null],
    ]);
  });
});
