import { createHash } from "node:crypto";

import { ReadError } from "./errors.js";

export type ProxyEndpoint = {
  uri: string;
  browser: {
    server: string;
    username?: string;
    password?: string;
  };
};

function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new ReadError("INVALID_ARGUMENT", "A proxy URL contains malformed credentials.", {
      cause: error,
    });
  }
}

export function parseProxyEndpoints(raw: string | undefined): ProxyEndpoint[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw.split(",").map((item) => {
    const value = item.trim();
    if (value === "" || !URL.canParse(value)) {
      throw new ReadError("INVALID_ARGUMENT", "CRAWLUME_PROXY_URLS contains an invalid URL.");
    }
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ReadError(
        "INVALID_ARGUMENT",
        "CRAWLUME_PROXY_URLS supports only http and https proxies.",
      );
    }
    if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
      throw new ReadError(
        "INVALID_ARGUMENT",
        "Proxy URLs must not contain a path, query, or fragment.",
      );
    }
    const username = url.username === "" ? undefined : decodeCredential(url.username);
    const password = url.password === "" ? undefined : decodeCredential(url.password);
    return {
      uri: url.toString(),
      browser: {
        server: `${url.protocol}//${url.host}`,
        ...(username === undefined ? {} : { username }),
        ...(password === undefined ? {} : { password }),
      },
    };
  });
}

export class ProxyPool {
  private nextIndex = 0;

  constructor(private readonly endpoints: ProxyEndpoint[]) {}

  acquire(stickyKey?: string): ProxyEndpoint | null {
    if (this.endpoints.length === 0) {
      return null;
    }
    if (stickyKey !== undefined) {
      const digest = createHash("sha256").update(stickyKey).digest();
      const index = digest.readUInt32BE(0) % this.endpoints.length;
      return this.endpoints[index] ?? null;
    }
    const endpoint = this.endpoints[this.nextIndex] ?? null;
    this.nextIndex = (this.nextIndex + 1) % this.endpoints.length;
    return endpoint;
  }

  get size(): number {
    return this.endpoints.length;
  }
}
