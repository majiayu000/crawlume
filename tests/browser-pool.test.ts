import type { Browser } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserPool } from "../src/browser-pool.js";
import { parseProxyEndpoints } from "../src/proxy.js";

type FakeBrowser = Browser & {
  connected: boolean;
  closeMock: ReturnType<typeof vi.fn>;
};

const pools: BrowserPool[] = [];

function config(overrides: Partial<ConstructorParameters<typeof BrowserPool>[0]> = {}) {
  return {
    browserPoolSize: 2,
    browserContextsPerInstance: 2,
    browserPoolWaitMs: 1_000,
    ...overrides,
  };
}

function fakeBrowser(): FakeBrowser {
  const browser = {
    connected: true,
    closeMock: vi.fn(),
    isConnected() {
      return this.connected;
    },
    async close() {
      this.connected = false;
      this.closeMock();
    },
  };
  return browser as unknown as FakeBrowser;
}

afterEach(async () => {
  while (pools.length > 0) {
    await pools.pop()?.close();
  }
});

describe("BrowserPool", () => {
  it("reuses a connected browser for consecutive contexts", async () => {
    const browser = fakeBrowser();
    const launcher = vi.fn(async () => browser);
    const pool = new BrowserPool(config(), launcher);
    pools.push(pool);

    const first = await pool.acquire(null);
    await first.release();
    const second = await pool.acquire(null);

    expect(second.browser).toBe(browser);
    expect(launcher).toHaveBeenCalledOnce();
    await second.release();
  });

  it("enforces per-browser context capacity and wakes on release", async () => {
    const browser = fakeBrowser();
    const pool = new BrowserPool(
      config({ browserPoolSize: 1, browserContextsPerInstance: 2 }),
      async () => browser,
    );
    pools.push(pool);
    const first = await pool.acquire(null);
    const second = await pool.acquire(null);
    let thirdResolved = false;
    const thirdPending = pool.acquire(null).then((lease) => {
      thirdResolved = true;
      return lease;
    });
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    await first.release();
    const third = await thirdPending;
    expect(third.browser).toBe(browser);
    await Promise.all([second.release(), third.release()]);
  });

  it("evicts an idle browser when a different proxy key needs the only slot", async () => {
    const [firstProxy, secondProxy] = parseProxyEndpoints(
      "http://one.example:8080,http://two.example:8080",
    );
    const browsers = [fakeBrowser(), fakeBrowser()];
    const launcher = vi.fn(async () => browsers.shift() as Browser);
    const pool = new BrowserPool(config({ browserPoolSize: 1 }), launcher);
    pools.push(pool);

    const first = await pool.acquire(firstProxy ?? null);
    const firstBrowser = first.browser as FakeBrowser;
    await first.release();
    const second = await pool.acquire(secondProxy ?? null);

    expect(firstBrowser.closeMock).toHaveBeenCalledOnce();
    expect(second.browser).not.toBe(firstBrowser);
    expect(launcher).toHaveBeenCalledTimes(2);
    await second.release();
  });

  it("removes disconnected browsers and launches a replacement", async () => {
    const browsers = [fakeBrowser(), fakeBrowser()];
    const launcher = vi.fn(async () => browsers.shift() as Browser);
    const pool = new BrowserPool(config({ browserPoolSize: 1 }), launcher);
    pools.push(pool);
    const first = await pool.acquire(null);
    (first.browser as FakeBrowser).connected = false;
    await first.release();

    const second = await pool.acquire(null);
    expect(launcher).toHaveBeenCalledTimes(2);
    await second.release();
  });

  it("recycles a connected browser after its bounded context lifetime", async () => {
    const browsers = [fakeBrowser(), fakeBrowser()];
    const launcher = vi.fn(async () => browsers.shift() as Browser);
    const pool = new BrowserPool(config({ browserPoolSize: 1 }), launcher);
    pools.push(pool);

    for (let context = 0; context < 100; context += 1) {
      const lease = await pool.acquire(null);
      await lease.release();
    }
    const replacement = await pool.acquire(null);

    expect(launcher).toHaveBeenCalledTimes(2);
    await replacement.release();
  });

  it("retires a browser lease reported unhealthy before the next acquisition", async () => {
    const browsers = [fakeBrowser(), fakeBrowser()];
    const launcher = vi.fn(async () => browsers.shift() as Browser);
    const pool = new BrowserPool(config({ browserPoolSize: 1 }), launcher);
    pools.push(pool);

    const unhealthy = await pool.acquire(null);
    await unhealthy.release(false);
    const replacement = await pool.acquire(null);

    expect(launcher).toHaveBeenCalledTimes(2);
    expect(replacement.browser).not.toBe(unhealthy.browser);
    await replacement.release();
  });

  it("does not retain capacity after a browser launch failure", async () => {
    const browser = fakeBrowser();
    const launcher = vi.fn()
      .mockRejectedValueOnce(new Error("launch failed"))
      .mockResolvedValueOnce(browser);
    const pool = new BrowserPool(config({ browserPoolSize: 1 }), launcher);
    pools.push(pool);

    await expect(pool.acquire(null)).rejects.toThrow("launch failed");
    const recovered = await pool.acquire(null);
    expect(recovered.browser).toBe(browser);
    await recovered.release();
  });

  it("cancels a waiter without releasing the active lease", async () => {
    const pool = new BrowserPool(
      config({ browserPoolSize: 1, browserContextsPerInstance: 1 }),
      async () => fakeBrowser(),
    );
    pools.push(pool);
    const active = await pool.acquire(null);
    const controller = new AbortController();
    const pending = pool.acquire(null, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "CRAWL_CANCELLED" });
    await active.release();
  });

  it("fails visibly when pool capacity remains exhausted", async () => {
    const pool = new BrowserPool(
      config({ browserPoolSize: 1, browserContextsPerInstance: 1, browserPoolWaitMs: 10 }),
      async () => fakeBrowser(),
    );
    pools.push(pool);
    const active = await pool.acquire(null);

    await expect(pool.acquire(null)).rejects.toMatchObject({
      code: "BROWSER_POOL_EXHAUSTED",
      retryable: true,
    });
    await active.release();
  });

  it("closes pooled browsers and rejects future leases", async () => {
    const browser = fakeBrowser();
    const pool = new BrowserPool(config(), async () => browser);
    const lease = await pool.acquire(null);
    await lease.release();
    await pool.close();

    expect(browser.closeMock).toHaveBeenCalledOnce();
    await expect(pool.acquire(null)).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
  });

  it("does not hand out a browser that finishes launching during shutdown", async () => {
    const browser = fakeBrowser();
    let finishLaunch: ((browser: Browser) => void) | undefined;
    const launch = new Promise<Browser>((resolve) => {
      finishLaunch = resolve;
    });
    const pool = new BrowserPool(config(), async () => launch);
    const acquiring = pool.acquire(null);
    const assertion = expect(acquiring).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    const closing = pool.close();
    finishLaunch?.(browser);

    await assertion;
    await closing;
    expect(browser.closeMock).toHaveBeenCalledOnce();
  });
});
