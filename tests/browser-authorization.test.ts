import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { listen } from "../benchmarks/harness/runtime.js";
import { BrowserPageFetcher } from "../src/fetch/browser.js";
import { ProfileManager } from "../src/profiles.js";
import { parseProxyEndpoints, ProxyPool } from "../src/proxy.js";
import type { RslPolicy } from "../src/rsl.js";
import type { RobotsPolicy } from "../src/security/robots.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import type { RslEvidence } from "../src/types.js";
import { publicResolver, testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Duplex>();

function trackSocket(socket: Duplex): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(async (server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

function policyStubs(): { robots: RobotsPolicy; rsl: RslPolicy } {
  const evidence: RslEvidence = {
    status: "not-declared",
    usage: "ai-input",
    discoveredBy: [],
    licenseUrls: [],
    licenseHashes: [],
    approvalsApplied: 0,
    licenseTokensApplied: 0,
  };
  return {
    robots: {
      assertAllowed: async () => undefined,
      licenseUrls: async () => [],
    } as unknown as RobotsPolicy,
    rsl: {
      emptyEvidence: () => evidence,
      authorizeRobots: async () => ({ evidence, authorization: null }),
      authorizeResponse: async () => ({ evidence, authorization: null }),
    } as unknown as RslPolicy,
  };
}

type AuthorizationHarness = {
  fetcher: BrowserPageFetcher;
  observedRequests: string[];
  proxyTargets: string[];
  dataDir: string;
};

async function authorizationHarness(
  respond: (
    hostname: string,
    path: string,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<AuthorizationHarness> {
  const observedRequests: string[] = [];
  const proxyTargets: string[] = [];
  const observedRespond = (
    hostname: string,
    path: string,
    response: import("node:http").ServerResponse,
  ): void => {
    observedRequests.push(`${hostname}${path}`);
    respond(hostname, path, response);
  };
  const origin = createServer((request, response) => {
    observedRespond(
      new URL(`http://${request.headers.host ?? "invalid"}`).hostname,
      request.url ?? "",
      response,
    );
  });
  origin.on("connection", (socket) => {
    trackSocket(socket);
  });
  const originPort = await listen(origin);
  servers.push(origin);
  const proxy = createServer((request, response) => {
    const target = new URL(request.url ?? "", "http://proxy.invalid");
    proxyTargets.push(target.toString());
    observedRespond(
      new URL(`http://${request.headers.host ?? "invalid"}`).hostname,
      target.pathname,
      response,
    );
  });
  proxy.on("connect", (_request, client, head) => {
    trackSocket(client);
    const upstream = connect(originPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    trackSocket(upstream);
    upstream.on("error", () => client.destroy());
  });
  const port = await listen(proxy);
  servers.push(proxy);
  const dataDir = await mkdtemp(join(tmpdir(), "crawlume-auth-origin-"));
  temporaryDirectories.push(dataDir);
  const endpoints = parseProxyEndpoints(`http://127.0.0.1:${port}`);
  const config = {
    ...testConfig(),
    dataDir,
    profilesDir: join(dataDir, "profiles"),
    proxyEndpoints: endpoints,
    browserTimeoutMs: 5_000,
  };
  const profiles = new ProfileManager(config);
  profiles.create("research");
  const { robots, rsl } = policyStubs();
  return {
    dataDir,
    observedRequests,
    proxyTargets,
    fetcher: new BrowserPageFetcher(
      config,
      new UrlPolicy(async () => publicResolver()),
      robots,
      profiles,
      rsl,
      new ProxyPool(endpoints),
    ),
  };
}

describe("BrowserPageFetcher authorization boundary", () => {
  it("rejects an authorized main-frame redirect outside allowedOrigins", async () => {
    let deniedOriginRequests = 0;
    const { dataDir, fetcher, observedRequests } = await authorizationHarness((hostname, _path, response) => {
      if (hostname === "allowed.example") {
        response.writeHead(302, { location: "http://denied.example/final" });
        response.end();
        return;
      }
      if (hostname === "denied.example") deniedOriginRequests += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<main>${"redirected private content ".repeat(40)}</main>`);
    });

    try {
      await expect(fetcher.fetch(new URL("http://allowed.example/start"), {
        authProfile: "research",
        allowedOrigins: ["http://allowed.example"],
      })).rejects.toMatchObject({
        code: "ACCESS_DENIED",
        details: { origin: "http://denied.example" },
      });
      expect(observedRequests).not.toContain("denied.example/final");
      expect(deniedOriginRequests).toBe(0);
      const traceFiles = await readdir(join(dataDir, "traces"));
      expect(traceFiles).toHaveLength(1);
      const trace = JSON.parse(await readFile(join(dataDir, "traces", traceFiles[0]!), "utf8")) as {
        authorized: boolean;
        dom: unknown;
      };
      expect(trace).toMatchObject({ authorized: true, dom: null });
      expect(JSON.stringify(trace)).not.toMatch(/research|redirected private content|authorization|cookie/iu);
    } finally {
      await fetcher.close();
    }
  }, 15_000);

  it("allows public third-party subresources without widening main-frame origins", async () => {
    const { fetcher, observedRequests, proxyTargets } = await authorizationHarness((hostname, path, response) => {
      if (hostname === "cdn.example" && path === "/marker.js") {
        response.writeHead(200, { "content-type": "application/javascript" });
        response.end("document.body.dataset.thirdPartyLoaded = 'true';");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<main>${"authorized article content ".repeat(40)}</main>` +
          '<script src="http://cdn.example/marker.js"></script>',
      );
    });

    try {
      const result = await fetcher.fetch(new URL("http://allowed.example/article"), {
        authProfile: "research",
        allowedOrigins: ["http://allowed.example"],
        browserReadiness: {
          target: { selector: "body[data-third-party-loaded='true']" },
          timeoutMs: 3_000,
        },
      });

      expect(result.finalUrl).toBe("http://allowed.example/article");
      expect(observedRequests).toContain("cdn.example/marker.js");
      expect(proxyTargets).toEqual(expect.arrayContaining([
        expect.stringMatching(/^http:\/\/93\.184\.216\.34(?::\d+)?\//u),
      ]));
      expect(proxyTargets.some((target) => /allowed\.example|cdn\.example/u.test(target))).toBe(false);
    } finally {
      await fetcher.close();
    }
  }, 15_000);

  it("records only bounded DOM structure for an anonymous browser failure", async () => {
    const secret = "private-message-cookie-token";
    const { dataDir, fetcher } = await authorizationHarness((_hostname, _path, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<main data-secret="${secret}"><p>${secret.repeat(40)}</p></main>`);
    });

    try {
      const failure = await fetcher.fetch(new URL("http://allowed.example/article?token=hidden"), {
        browserReadiness: {
          target: { selector: ".never-ready" },
          timeoutMs: 100,
        },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "FETCH_TIMEOUT",
        traceRef: expect.stringMatching(/^browser-trace:/u),
      });

      const traceFiles = await readdir(join(dataDir, "traces"));
      expect(traceFiles).toHaveLength(1);
      const serialized = await readFile(join(dataDir, "traces", traceFiles[0]!), "utf8");
      const trace = JSON.parse(serialized) as { authorized: boolean; dom: Array<{ tag: string }> };
      expect(trace.authorized).toBe(false);
      expect(trace.dom.map(({ tag }) => tag)).toContain("main");
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(32_768);
      expect(serialized).not.toMatch(/private-message|token=hidden|data-secret|authorization|cookie/iu);
    } finally {
      await fetcher.close();
    }
  }, 15_000);
});
