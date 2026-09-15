#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";

export async function main(): Promise<void> {
  const app = createApp(loadConfig(), { runCrawlWorker: true });
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  let closing = false;

  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await server.close();
    await app.close();
  };

  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await server.connect(transport);
}

const entry = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entry !== "" && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`crawlume-mcp failed: ${message}\n`);
    process.exitCode = 1;
  });
}
