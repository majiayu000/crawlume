import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export type McpProcessOptions = {
  dataDirectory: string;
  environment?: Record<string, string>;
  cwd?: string;
  controlledDns?: boolean;
};

const controlledDnsModule = new URL("./controlled-dns.mjs", import.meta.url).href;

export type BuiltMcpProcess = {
  client: Client;
  pid: number;
  stderr(): string;
  listTools(): Promise<string[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  close(): Promise<void>;
};

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolveExit, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const check = (): void => {
      if (!processExists(pid)) {
        if (timer !== undefined) clearTimeout(timer);
        resolveExit();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`MCP process ${pid} did not exit within ${timeoutMs}ms`));
        return;
      }
      timer = setTimeout(check, 10);
    };
    check();
  });
}

export async function startBuiltMcpProcess(options: McpProcessOptions): Promise<BuiltMcpProcess> {
  if (options.dataDirectory.length === 0) {
    throw new Error("dataDirectory must be non-empty");
  }
  const cwd = options.cwd ?? process.cwd();
  const serverPath = resolve(cwd, "dist/server.js");
  try {
    await access(serverPath, constants.R_OK);
  } catch (error) {
    throw new Error(
      `built MCP server is missing at ${serverPath}; run the repository build before E2E tests`,
      { cause: error },
    );
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: options.controlledDns === true ? ["--import", controlledDnsModule, serverPath] : [serverPath],
    cwd,
    env: {
      ...inheritedEnvironment(),
      CRAWLUME_DATA_DIR: options.dataDirectory,
      ...options.environment,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-1_000_000);
  });
  const client = new Client({ name: "crawlume-durable-e2e", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    const detail = stderr.trim();
    throw new Error(
      detail.length === 0
        ? "built MCP server failed during stdio initialization"
        : `built MCP server failed during stdio initialization: ${detail}`,
      { cause: error },
    );
  }
  const pid = transport.pid;
  if (pid === null) {
    await client.close();
    throw new Error("MCP stdio transport connected without exposing a child process PID");
  }

  let closed = false;
  return {
    client,
    pid,
    stderr: () => stderr,
    async listTools() {
      const listed = await client.listTools();
      return listed.tools.map((tool) => tool.name);
    },
    callTool(name, args = {}) {
      return client.callTool({ name, arguments: args });
    },
    async kill(signal = "SIGKILL") {
      if (closed || !processExists(pid)) return;
      process.kill(pid, signal);
      await waitForProcessExit(pid);
      closed = true;
      await client.close().catch(() => undefined);
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
      if (processExists(pid)) {
        await waitForProcessExit(pid);
      }
    },
  };
}
