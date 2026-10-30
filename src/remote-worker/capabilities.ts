import { existsSync } from "node:fs";

import type { AppConfig } from "../config.js";

/** The channel default cannot be checked without launching, so only a configured executable counts. */
export function workerCapabilities(
  config: Pick<AppConfig, "browserExecutable">,
): Readonly<Record<string, true>> {
  const browser = config.browserExecutable !== null && existsSync(config.browserExecutable);
  return { http: true, pdf: true, feed: true, ...(browser ? { browser: true } : {}) };
}
