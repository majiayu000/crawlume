import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

import { parseProxyEndpoints, type ProxyEndpoint } from "./proxy.js";

export type AppConfig = {
  dataDir: string;
  cachePath: string;
  profilesDir: string;
  userAgent: string;
  agentIdentityUrl: string | null;
  webBotAuthJwkPath: string | null;
  webBotAuthProfile: "cloudflare-legacy";
  webBotAuthTtlSeconds: number;
  rslUsage: RslUsage;
  rslUserClass: RslUserClass | null;
  rslGeo: string | null;
  requestTimeoutMs: number;
  browserTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  robotsCacheSeconds: number;
  defaultCacheSeconds: number;
  crawlMaxAttempts: number;
  crawlRetryBaseMs: number;
  crawlMaxRetryDelayMs: number;
  crawlMinHostIntervalMs: number;
  browserPoolSize: number;
  browserContextsPerInstance: number;
  browserPoolWaitMs: number;
  browserChannel: string;
  browserExecutable: string | null;
  allowDnsFakeIp: boolean;
  localIndexEnabled: boolean;
  proxyEndpoints: ProxyEndpoint[];
  searxngUrl: string | null;
};

export const rslUsages = ["ai-train", "ai-input", "ai-index", "search"] as const;
export type RslUsage = (typeof rslUsages)[number];
export const rslUserClasses = [
  "commercial",
  "non-commercial",
  "education",
  "government",
  "personal",
] as const;
export type RslUserClass = (typeof rslUserClasses)[number];

function enumValue<const T extends readonly string[]>(
  name: string,
  values: T,
  fallback: T[number] | null,
): T[number] | null {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  if (!(values as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  }
  return raw as T[number];
}

function rslGeo(): string | null {
  const raw = process.env.DIAOYAN_RSL_GEO;
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  if (!/^[A-Z]{2}$/.test(raw)) {
    throw new Error("DIAOYAN_RSL_GEO must be two uppercase ASCII letters.");
  }
  return raw;
}

function agentIdentityUrl(): string | null {
  const raw = process.env.DIAOYAN_AGENT_IDENTITY_URL;
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DIAOYAN_AGENT_IDENTITY_URL must be a valid HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "DIAOYAN_AGENT_IDENTITY_URL must be HTTPS and must not contain credentials, query, or fragment.",
    );
  }
  return parsed.toString();
}

function webBotAuthJwkPath(): string | null {
  const raw = process.env.DIAOYAN_WEB_BOT_AUTH_JWK_PATH;
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  if (!isAbsolute(raw)) {
    throw new Error("DIAOYAN_WEB_BOT_AUTH_JWK_PATH must be an absolute path.");
  }
  return raw;
}

function webBotAuthProfile(): "cloudflare-legacy" {
  const raw = process.env.DIAOYAN_WEB_BOT_AUTH_PROFILE ?? "cloudflare-legacy";
  if (raw !== "cloudflare-legacy") {
    throw new Error("DIAOYAN_WEB_BOT_AUTH_PROFILE must be cloudflare-legacy.");
  }
  return raw;
}

function defaultDataDir(): string {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "diaoyan");
  }
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? homedir(), "diaoyan");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "diaoyan");
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function booleanFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "1" || raw.toLowerCase() === "true") {
    return true;
  }
  if (raw === "0" || raw.toLowerCase() === "false") {
    return false;
  }
  throw new Error(`${name} must be 1, 0, true, or false.`);
}

function integerInRange(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DIAOYAN_DATA_DIR ?? defaultDataDir();
  const identityUrl = agentIdentityUrl();
  const jwkPath = webBotAuthJwkPath();
  if (jwkPath !== null && identityUrl === null) {
    throw new Error(
      "DIAOYAN_AGENT_IDENTITY_URL is required when DIAOYAN_WEB_BOT_AUTH_JWK_PATH is set.",
    );
  }
  return {
    dataDir,
    cachePath: join(dataDir, "cache.sqlite"),
    profilesDir: join(dataDir, "profiles"),
    userAgent: process.env.DIAOYAN_USER_AGENT ?? "DiaoyanWebReader/0.10",
    agentIdentityUrl: identityUrl,
    webBotAuthJwkPath: jwkPath,
    webBotAuthProfile: webBotAuthProfile(),
    webBotAuthTtlSeconds: integerInRange(
      "DIAOYAN_WEB_BOT_AUTH_TTL_SECONDS",
      60,
      10,
      300,
    ),
    rslUsage: enumValue("DIAOYAN_RSL_USAGE", rslUsages, "ai-input") ?? "ai-input",
    rslUserClass: enumValue("DIAOYAN_RSL_USER_CLASS", rslUserClasses, null),
    rslGeo: rslGeo(),
    requestTimeoutMs: positiveInteger("DIAOYAN_REQUEST_TIMEOUT_MS", 20_000),
    browserTimeoutMs: positiveInteger("DIAOYAN_BROWSER_TIMEOUT_MS", 30_000),
    maxResponseBytes: positiveInteger("DIAOYAN_MAX_RESPONSE_BYTES", 5_000_000),
    maxRedirects: positiveInteger("DIAOYAN_MAX_REDIRECTS", 5),
    robotsCacheSeconds: positiveInteger("DIAOYAN_ROBOTS_CACHE_SECONDS", 3_600),
    defaultCacheSeconds: positiveInteger("DIAOYAN_DEFAULT_CACHE_SECONDS", 900),
    crawlMaxAttempts: integerInRange("DIAOYAN_CRAWL_MAX_ATTEMPTS", 3, 1, 10),
    crawlRetryBaseMs: integerInRange("DIAOYAN_CRAWL_RETRY_BASE_MS", 500, 0, 60_000),
    crawlMaxRetryDelayMs: integerInRange(
      "DIAOYAN_CRAWL_MAX_RETRY_DELAY_MS",
      30_000,
      1,
      600_000,
    ),
    crawlMinHostIntervalMs: integerInRange(
      "DIAOYAN_CRAWL_MIN_HOST_INTERVAL_MS",
      250,
      0,
      60_000,
    ),
    browserPoolSize: integerInRange("DIAOYAN_BROWSER_POOL_SIZE", 2, 1, 16),
    browserContextsPerInstance: integerInRange(
      "DIAOYAN_BROWSER_CONTEXTS_PER_INSTANCE",
      4,
      1,
      32,
    ),
    browserPoolWaitMs: integerInRange("DIAOYAN_BROWSER_POOL_WAIT_MS", 30_000, 1, 300_000),
    browserChannel: process.env.DIAOYAN_BROWSER_CHANNEL ?? "chrome",
    browserExecutable: process.env.DIAOYAN_BROWSER_EXECUTABLE ?? null,
    allowDnsFakeIp: booleanFlag("DIAOYAN_ALLOW_DNS_FAKE_IP", false),
    localIndexEnabled: booleanFlag("DIAOYAN_LOCAL_INDEX_ENABLED", false),
    proxyEndpoints: parseProxyEndpoints(process.env.DIAOYAN_PROXY_URLS),
    searxngUrl: process.env.DIAOYAN_SEARXNG_URL ?? null,
  };
}
