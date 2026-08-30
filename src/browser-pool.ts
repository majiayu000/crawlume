import type { Browser } from "playwright-core";

import type { AppConfig } from "./config.js";
import { crawlCancelledError, ReadError } from "./errors.js";
import type { ProxyEndpoint } from "./proxy.js";

type BrowserPoolConfig = Pick<
  AppConfig,
  "browserPoolSize" | "browserContextsPerInstance" | "browserPoolWaitMs"
>;

type BrowserLauncher = (proxy: ProxyEndpoint | null) => Promise<Browser>;

type PoolEntry = {
  key: string;
  launch: Promise<Browser>;
  activeContexts: number;
  contextStarts: number;
  retiring: boolean;
};

const maxContextStartsPerBrowser = 100;

export type BrowserLease = {
  browser: Browser;
  release(healthy?: boolean): Promise<void>;
};

export class BrowserPool {
  private readonly entries: PoolEntry[] = [];
  private readonly waiters = new Set<() => void>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly config: BrowserPoolConfig,
    private readonly launcher: BrowserLauncher,
  ) {}

  async acquire(proxy: ProxyEndpoint | null, signal?: AbortSignal): Promise<BrowserLease> {
    const key = proxy?.uri ?? "direct";
    while (true) {
      if (this.closing) {
        throw new ReadError("BROWSER_UNAVAILABLE", "The browser pool is closed.");
      }
      if (signal?.aborted === true) {
        throw crawlCancelledError();
      }

      const reusable = this.entries.find(
        (entry) =>
          entry.key === key &&
          !entry.retiring &&
          entry.contextStarts < maxContextStartsPerBrowser &&
          entry.activeContexts < this.config.browserContextsPerInstance,
      );
      if (reusable !== undefined) {
        reusable.activeContexts += 1;
        reusable.contextStarts += 1;
        return this.resolveLease(reusable);
      }

      if (this.entries.length < this.config.browserPoolSize) {
        const entry: PoolEntry = {
          key,
          launch: this.launcher(proxy),
          activeContexts: 1,
          contextStarts: 1,
          retiring: false,
        };
        this.entries.push(entry);
        return this.resolveLease(entry);
      }

      const idle = this.entries.find((entry) => entry.activeContexts === 0);
      if (idle !== undefined) {
        this.removeEntry(idle);
        await this.closeEntry(idle);
        continue;
      }

      await this.waitForCapacity(signal);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closing = true;
    this.notifyWaiters();
    const entries = this.entries.splice(0);
    this.closePromise = Promise.all(entries.map(async (entry) => this.closeEntry(entry))).then(
      () => undefined,
    );
    return this.closePromise;
  }

  private async resolveLease(entry: PoolEntry): Promise<BrowserLease> {
    let browser: Browser;
    try {
      browser = await entry.launch;
    } catch (error) {
      entry.activeContexts = Math.max(0, entry.activeContexts - 1);
      this.removeEntry(entry);
      this.notifyWaiters();
      throw error;
    }
    if (this.closing) {
      entry.activeContexts = Math.max(0, entry.activeContexts - 1);
      throw new ReadError("BROWSER_UNAVAILABLE", "The browser pool closed during launch.");
    }
    if (!browser.isConnected()) {
      entry.activeContexts = Math.max(0, entry.activeContexts - 1);
      this.removeEntry(entry);
      this.notifyWaiters();
      throw new ReadError("BROWSER_UNAVAILABLE", "The pooled browser disconnected.", {
        retryable: true,
      });
    }

    let released = false;
    return {
      browser,
      release: async (healthy = true): Promise<void> => {
        if (released) {
          return;
        }
        released = true;
        entry.activeContexts = Math.max(0, entry.activeContexts - 1);
        if (!healthy || !browser.isConnected() || entry.contextStarts >= maxContextStartsPerBrowser) {
          entry.retiring = true;
        }
        if (entry.retiring && entry.activeContexts === 0) {
          this.removeEntry(entry);
          if (browser.isConnected()) await browser.close();
        }
        this.notifyWaiters();
      },
    };
  }

  private async waitForCapacity(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) {
      throw crawlCancelledError();
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const wake = (): void => finish(resolve);
      const onAbort = (): void => finish(() => reject(crawlCancelledError()));
      const timer = setTimeout(
        () => finish(() => reject(new ReadError(
          "BROWSER_POOL_EXHAUSTED",
          "The browser pool remained full beyond its wait limit.",
          {
            retryable: true,
            details: {
              browserPoolSize: this.config.browserPoolSize,
              browserPoolWaitMs: this.config.browserPoolWaitMs,
            },
          },
        ))),
        this.config.browserPoolWaitMs,
      );
      this.waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private removeEntry(entry: PoolEntry): void {
    const index = this.entries.indexOf(entry);
    if (index !== -1) {
      this.entries.splice(index, 1);
    }
  }

  private async closeEntry(entry: PoolEntry): Promise<void> {
    const browser = await entry.launch;
    await browser.close();
  }

  private notifyWaiters(): void {
    for (const wake of [...this.waiters]) {
      wake();
    }
  }
}
