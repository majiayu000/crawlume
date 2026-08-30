#!/usr/bin/env node

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { normalizeError, ReadError } from "../errors.js";

async function main(): Promise<void> {
  const url = process.argv[2] ?? "https://httpbin.org/html";
  const browserOption = process.argv[3] ?? "no-browser";
  const app = createApp(loadConfig(), { runCrawlWorker: false });
  try {
    if (browserOption !== "browser" && browserOption !== "no-browser") {
      throw new ReadError("INVALID_ARGUMENT", "Browser option must be browser or no-browser.", {
        details: { browserOption },
      });
    }
    const result = await app.reader.readPage({
      url,
      browserAllowed: browserOption === "browser",
      cacheMode: "live",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(normalizeError(error).toJSON(), null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
