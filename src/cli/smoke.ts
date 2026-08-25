#!/usr/bin/env node

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { normalizeError, ReadError } from "../errors.js";

async function main(): Promise<void> {
  const url = process.argv[2] ?? "https://httpbin.org/html";
  const requestedMode = process.argv[3] ?? "http";
  const app = createApp(loadConfig());
  try {
    if (requestedMode !== "http" && requestedMode !== "browser" && requestedMode !== "auto") {
      throw new ReadError("INVALID_ARGUMENT", "Mode must be http, browser, or auto.", {
        details: { mode: requestedMode },
      });
    }
    const result = await app.reader.readPage({ url, mode: requestedMode, cacheMode: "live" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(normalizeError(error).toJSON(), null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
