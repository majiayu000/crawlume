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

export function parseRobotsLicenseUrls(text: string, userAgent: string): string[] {
  type Group = { agents: string[]; licenses: string[] };
  const globals: string[] = [];
  const groups: Group[] = [];
  let group: Group | null = null;
  let groupHasDirectives = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (group === null || groupHasDirectives) {
        group = { agents: [], licenses: [] };
        groups.push(group);
        groupHasDirectives = false;
      }
      if (value.length > 0) {
        group.agents.push(value.toLowerCase());
      }
      continue;
    }
    if (group === null) {
      if (field === "license" && /^https?:\/\//i.test(value)) {
        globals.push(value);
      }
      continue;
    }
    groupHasDirectives = true;
    if (field === "license" && /^https?:\/\//i.test(value)) {
      group.licenses.push(value);
    }
  }

  const product = userAgent.split(/[\s/]/, 1)[0]?.toLowerCase() ?? userAgent.toLowerCase();
  let bestLength = -1;
  const selected: string[] = [];
  for (const candidate of groups) {
    const matchingLengths = candidate.agents
      .filter((agent) => agent === "*" || product.includes(agent))
      .map((agent) => (agent === "*" ? 0 : agent.length));
    const matchLength = matchingLengths.length === 0 ? -1 : Math.max(...matchingLengths);
    if (matchLength < bestLength) {
      continue;
    }
    if (matchLength > bestLength) {
      selected.length = 0;
      bestLength = matchLength;
    }
    if (matchLength >= 0) {
      selected.push(...candidate.licenses);
    }
  }
  const applicable = selected.length > 0 ? selected : globals;
  return [...new Set(applicable)];
}

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

  async licenseUrls(url: URL): Promise<string[]> {
    const cached = await this.load(url.origin);
    return cached.text === null ? [] : parseRobotsLicenseUrls(cached.text, this.config.userAgent);
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
