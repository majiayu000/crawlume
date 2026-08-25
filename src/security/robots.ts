import { createRequire } from "node:module";

import type { AppConfig } from "../config.js";
import { ReadError } from "../errors.js";
import type { HttpTransport } from "../fetch/http.js";

type CachedRobots = {
  expiresAt: number;
  robotsUrl: string;
  text: string | null;
};

type RobotsParser = (
  url: string,
  text: string,
) => { isAllowed(targetUrl: string, userAgent?: string): boolean | undefined };

const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser") as RobotsParser;

export class RobotsPolicy {
  private readonly cache = new Map<string, CachedRobots>();

  constructor(
    private readonly config: AppConfig,
    private readonly transport: HttpTransport,
  ) {}

  async assertAllowed(url: URL): Promise<void> {
    const cached = await this.load(url.origin);
    if (cached.text === null) {
      return;
    }
    const robots = robotsParser(cached.robotsUrl, cached.text);
    if (robots.isAllowed(url.toString(), this.config.userAgent) === false) {
      throw new ReadError("ROBOTS_DISALLOWED", "robots.txt disallows this page for the reader.", {
        details: { url: url.toString(), robotsUrl: cached.robotsUrl },
      });
    }
  }

  private async load(origin: string): Promise<CachedRobots> {
    const existing = this.cache.get(origin);
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      return existing;
    }

    const robotsUrl = new URL("/robots.txt", origin);
    let response;
    try {
      response = await this.transport.fetch(robotsUrl, { maxBytes: 1_000_000 });
    } catch (error) {
      throw new ReadError("ROBOTS_UNAVAILABLE", "robots.txt could not be retrieved safely.", {
        retryable: true,
        details: { robotsUrl: robotsUrl.toString() },
        cause: error,
      });
    }

    if (response.status === 404 || response.status === 410) {
      const missing = {
        expiresAt: Date.now() + this.config.robotsCacheSeconds * 1_000,
        robotsUrl: response.url.toString(),
        text: null,
      };
      this.cache.set(origin, missing);
      return missing;
    }
    if (response.status !== 200) {
      throw new ReadError("ROBOTS_UNAVAILABLE", `robots.txt returned HTTP ${response.status}.`, {
        retryable: response.status >= 500,
        details: { httpStatus: response.status, robotsUrl: response.url.toString() },
      });
    }

    const loaded = {
      expiresAt: Date.now() + this.config.robotsCacheSeconds * 1_000,
      robotsUrl: response.url.toString(),
      text: response.body,
    };
    this.cache.set(origin, loaded);
    return loaded;
  }
}
