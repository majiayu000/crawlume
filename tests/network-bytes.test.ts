import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { listen } from "../benchmarks/harness/runtime.js";
import { HttpPageFetcher, HttpTransport } from "../src/fetch/http.js";
import { parseProxyEndpoints } from "../src/proxy.js";
import { RslPolicy } from "../src/rsl.js";
import { RobotsPolicy } from "../src/security/robots.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { testConfig } from "./helpers.js";

const servers: Server[] = [];
const transports: HttpTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map(async (transport) => transport.close()));
  await Promise.all(servers.splice(0).map(async (server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

async function fetcherFor(handler: (url: string, response: import("node:http").ServerResponse) => void) {
  const origin = createServer((request, response) => {
    handler(request.url ?? "", response);
  });
  const port = await listen(origin);
  servers.push(origin);
  const endpoints = parseProxyEndpoints(`http://127.0.0.1:${port}`);
  const transport = new HttpTransport(
    { ...testConfig(), proxyEndpoints: endpoints, crawlMinHostIntervalMs: 0 },
    new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]),
  );
  transports.push(transport);
  const robots = new RobotsPolicy(testConfig(), transport);
  const rsl = new RslPolicy(testConfig(), transport);
  return new HttpPageFetcher(transport, robots, rsl);
}

describe("full-chain transfer accounting", () => {
  it("includes robots.txt bytes with the main document", async () => {
    const robotsBody = "User-agent: *\nAllow: /\n";
    const pageBody = "<html><body>counted</body></html>";
    const fetcher = await fetcherFor((url, response) => {
      if (url === "/robots.txt" || url.endsWith("/robots.txt")) {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-length": Buffer.byteLength(robotsBody),
        });
        response.end(robotsBody);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(pageBody);
    });

    const page = await fetcher.fetch(new URL("http://rebind.example/article"));
    expect(page.responseBytes).toBe(Buffer.byteLength(pageBody));
    expect(page.networkBytesIn).toBeGreaterThan(page.responseBytes);
    expect(page.networkBytesIn).toBeGreaterThanOrEqual(
      Buffer.byteLength(robotsBody) + Buffer.byteLength(pageBody),
    );
  });

  it("counts redirect Content-Length before following the next hop", async () => {
    const robotsBody = "User-agent: *\nAllow: /\n";
    const redirectPad = "redirect-pad";
    const finalBody = "<html><body>final</body></html>";
    const fetcher = await fetcherFor((url, response) => {
      if (url.includes("robots.txt")) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(robotsBody);
        return;
      }
      if (url.includes("/from")) {
        response.writeHead(302, {
          location: "http://rebind.example/to",
          "content-length": Buffer.byteLength(redirectPad),
        });
        response.end(redirectPad);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(finalBody);
    });

    const page = await fetcher.fetch(new URL("http://rebind.example/from"));
    expect(page.responseBytes).toBe(Buffer.byteLength(finalBody));
    expect(page.networkBytesIn ?? 0).toBeGreaterThanOrEqual(
      Buffer.byteLength(robotsBody) + Buffer.byteLength(redirectPad) + Buffer.byteLength(finalBody),
    );
  });
});
