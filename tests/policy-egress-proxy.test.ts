import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { fetch, ProxyAgent } from "undici";

import { listen } from "../benchmarks/harness/runtime.js";
import { HttpTransport } from "../src/fetch/http.js";
import { parseProxyEndpoints } from "../src/proxy.js";
import { PolicyEgressProxy } from "../src/security/policy-egress-proxy.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { testConfig } from "./helpers.js";

const servers: Server[] = [];
const dispatchers: ProxyAgent[] = [];
const proxies: PolicyEgressProxy[] = [];

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map(async (dispatcher) => dispatcher.close()));
  await Promise.all(proxies.splice(0).map(async (proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map(async (server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

describe("PolicyEgressProxy", () => {
  it("connects direct traffic to the approved address instead of resolving the hostname again", async () => {
    const hosts: Array<string | undefined> = [];
    const origin = createServer((request, response) => {
      hosts.push(request.headers.host);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("direct-pinned");
    });
    const port = await listen(origin);
    servers.push(origin);
    const policy = new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]);
    policy.assertPublic = async () => [{ address: "127.0.0.1", family: 4 }];
    const proxy = new PolicyEgressProxy(policy);
    proxies.push(proxy);
    const localEndpoint = await proxy.endpoint(null);
    const dispatcher = new ProxyAgent(localEndpoint.uri);
    dispatchers.push(dispatcher);

    const response = await fetch(`http://direct.example:${port}/article`, { dispatcher });

    expect(await response.text()).toBe("direct-pinned");
    expect(hosts).toEqual([`direct.example:${port}`]);
  });

  it("sends an administrator proxy the approved IP while preserving the target Host", async () => {
    const requests: Array<{ url: string; host: string | undefined }> = [];
    const upstream = createServer((request, response) => {
      requests.push({ url: request.url ?? "", host: request.headers.host });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("pinned");
    });
    const port = await listen(upstream);
    servers.push(upstream);
    const [configuredProxy] = parseProxyEndpoints(`http://127.0.0.1:${port}`);
    if (configuredProxy === undefined) throw new Error("The test proxy endpoint was not parsed.");
    const policy = new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]);
    const proxy = new PolicyEgressProxy(policy);
    proxies.push(proxy);
    const localEndpoint = await proxy.endpoint(configuredProxy);
    const dispatcher = new ProxyAgent(localEndpoint.uri);
    dispatchers.push(dispatcher);

    const response = await fetch("http://rebind.example/article", { dispatcher });

    expect(await response.text()).toBe("pinned");
    expect(requests).toEqual([{
      url: "http://93.184.216.34/article",
      host: "rebind.example",
    }]);
  });

  it("protects the real HTTP transport when an administrator proxy is configured", async () => {
    const targets: string[] = [];
    const events: string[] = [];
    const upstream = createServer((request, response) => {
      events.push("target-request");
      targets.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("transport-pinned");
    });
    const port = await listen(upstream);
    servers.push(upstream);
    const endpoints = parseProxyEndpoints(`http://127.0.0.1:${port}`);
    const transport = new HttpTransport(
      { ...testConfig(), proxyEndpoints: endpoints },
      new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]),
    );

    try {
      const response = await transport.fetch(new URL("http://rebind.example/article"), {
        beforeRequest: async () => {
          events.push("policy-complete");
        },
        onNetworkRequestStart: () => {
          events.push("network-start");
        },
      });
      expect(response.body).toBe("transport-pinned");
      expect(response.proxyUsed).toBe(true);
      expect(targets).toEqual(["http://93.184.216.34/article"]);
      expect(events).toEqual(["policy-complete", "network-start", "target-request"]);
    } finally {
      await transport.close();
    }
  });

  it("does not dispatch when the network-start boundary rejects the request", async () => {
    const targets: string[] = [];
    const upstream = createServer((request, response) => {
      targets.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("must-not-arrive");
    });
    const port = await listen(upstream);
    servers.push(upstream);
    const endpoints = parseProxyEndpoints(`http://127.0.0.1:${port}`);
    const transport = new HttpTransport(
      { ...testConfig(), proxyEndpoints: endpoints },
      new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]),
    );

    try {
      await expect(transport.fetch(new URL("http://rebind.example/article"), {
        onNetworkRequestStart: () => {
          throw new Error("stale crawl lease");
        },
      })).rejects.toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
      expect(targets).toEqual([]);
    } finally {
      await transport.close();
    }
  });
});
