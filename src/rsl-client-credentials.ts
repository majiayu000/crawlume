import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";

export type RslClientCredential = {
  server: string;
  clientId: string;
  clientSecret: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRslServer(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Every RSL client server must be a valid HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "Every RSL client server must be HTTPS and must not contain credentials, query, or fragment.",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function boundedSecretField(value: unknown, field: "clientId" | "clientSecret"): string {
  const maximum = field === "clientId" ? 1_000 : 10_000;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`Every RSL client ${field} must be a non-empty bounded single-line string.`);
  }
  return value;
}

function parseCredential(value: unknown): RslClientCredential {
  if (!isRecord(value) || typeof value.server !== "string") {
    throw new Error("Every RSL client entry must contain server, clientId, and clientSecret.");
  }
  return {
    server: normalizeRslServer(value.server),
    clientId: boundedSecretField(value.clientId, "clientId"),
    clientSecret: boundedSecretField(value.clientSecret, "clientSecret"),
  };
}

export class RslClientCredentialStore {
  private readonly clients: Map<string, RslClientCredential>;

  constructor(path: string) {
    if (!existsSync(path)) {
      this.clients = new Map();
      return;
    }
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("The RSL clients path must point to a regular file.");
    if (platform() !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("The RSL clients file must not be accessible by group or other users.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("The RSL clients file must contain valid JSON.");
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.clients)) {
      throw new Error("The RSL clients file must use version 1 with a clients array.");
    }
    const clients = parsed.clients.map(parseCredential);
    if (new Set(clients.map((client) => client.server)).size !== clients.length) {
      throw new Error("The RSL clients file must not contain duplicate License Servers.");
    }
    this.clients = new Map(clients.map((client) => [client.server, client]));
  }

  get(server: string): RslClientCredential | null {
    return this.clients.get(normalizeRslServer(server)) ?? null;
  }
}
