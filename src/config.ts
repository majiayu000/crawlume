import { homedir, platform } from "node:os";
import { join } from "node:path";

export type AppConfig = {
  dataDir: string;
  cachePath: string;
  profilesDir: string;
  userAgent: string;
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
  browserChannel: string;
  browserExecutable: string | null;
  allowDnsFakeIp: boolean;
  localIndexEnabled: boolean;
  searxngUrl: string | null;
};

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
  return {
    dataDir,
    cachePath: join(dataDir, "cache.sqlite"),
    profilesDir: join(dataDir, "profiles"),
    userAgent: process.env.DIAOYAN_USER_AGENT ?? "DiaoyanWebReader/0.1",
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
    browserChannel: process.env.DIAOYAN_BROWSER_CHANNEL ?? "chrome",
    browserExecutable: process.env.DIAOYAN_BROWSER_EXECUTABLE ?? null,
    allowDnsFakeIp: booleanFlag("DIAOYAN_ALLOW_DNS_FAKE_IP", false),
    localIndexEnabled: booleanFlag("DIAOYAN_LOCAL_INDEX_ENABLED", false),
    searxngUrl: process.env.DIAOYAN_SEARXNG_URL ?? null,
  };
}
