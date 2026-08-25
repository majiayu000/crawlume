import { describe, expect, it } from "vitest";

import { browserLaunchOptions } from "../src/fetch/browser.js";
import { parseProxyEndpoints, ProxyPool } from "../src/proxy.js";
import { testConfig } from "./helpers.js";

describe("proxy configuration", () => {
  it("keeps direct mode when no administrator pool is configured", () => {
    expect(parseProxyEndpoints(undefined)).toEqual([]);
    expect(new ProxyPool([]).acquire()).toBeNull();
  });

  it("parses HTTP proxy credentials for Undici and Playwright", () => {
    const [endpoint] = parseProxyEndpoints(
      "https://user%40example:p%3Ass@proxy.example:8443",
    );

    expect(endpoint).toEqual({
      uri: "https://user%40example:p%3Ass@proxy.example:8443/",
      browser: {
        server: "https://proxy.example:8443",
        username: "user@example",
        password: "p:ss",
      },
    });
    expect(browserLaunchOptions(testConfig(), true, endpoint ?? null)).toMatchObject({
      headless: true,
      proxy: endpoint?.browser,
    });
  });

  it("rotates ordinary requests and keeps profile selection stable", () => {
    const endpoints = parseProxyEndpoints(
      "http://proxy-one.example:8080,http://proxy-two.example:8080",
    );
    const pool = new ProxyPool(endpoints);

    expect(pool.acquire()?.browser.server).toBe("http://proxy-one.example:8080");
    expect(pool.acquire()?.browser.server).toBe("http://proxy-two.example:8080");
    expect(pool.acquire()?.browser.server).toBe("http://proxy-one.example:8080");
    const profileProxy = pool.acquire("research")?.uri;
    expect(pool.acquire("research")?.uri).toBe(profileProxy);
    expect(new ProxyPool(endpoints).acquire("research")?.uri).toBe(profileProxy);
  });

  it.each([
    "socks5://proxy.example:1080",
    "http://proxy.example/path",
    "http://proxy.example?token=secret",
    "http://proxy.example#fragment",
    "not-a-url",
    "http://one.example,,http://two.example",
  ])("rejects unsupported proxy configuration without echoing it: %s", (value) => {
    expect(() => parseProxyEndpoints(value)).toThrow();
    try {
      parseProxyEndpoints(value);
    } catch (error) {
      expect(String(error)).not.toContain("token=secret");
    }
  });
});
