import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ReadError, type ReadErrorCode } from "./errors.js";

const traceReference = /^browser-trace:([0-9a-f-]{36})$/u;
const maxDomNodes = 256;
const maxTraceBytes = 32_768;
const maxTraceFiles = 100;
const maxCounter = 100_000;

export type BrowserTracePhase =
  | "policy"
  | "context"
  | "navigation"
  | "readiness"
  | "response";

export type BrowserDomNodeTrace = {
  tag: string;
  childElements: number;
  textCharacters: number;
};

export type BrowserFailureTraceInput = {
  authorized: boolean;
  phase: BrowserTracePhase;
  errorCode: ReadErrorCode;
  elapsedMs: number;
  dom: BrowserDomNodeTrace[] | null;
  domCapture?: "captured" | "omitted_authorized" | "unavailable";
  network: {
    observedEvents: number;
    failedRequests: number;
    resourceTypes: Record<string, number>;
    statusClasses: Record<string, number>;
  };
  console: Record<string, number>;
};

export type BrowserFailureTrace = BrowserFailureTraceInput & {
  schemaVersion: 1;
  createdAt: string;
};

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(maxCounter, Math.floor(value));
}

function boundedCounters(
  source: Record<string, number>,
  allowed: readonly string[],
): Record<string, number> {
  return Object.fromEntries(allowed.map((key) => [key, boundedCount(source[key] ?? 0)]));
}

function safeDom(nodes: BrowserDomNodeTrace[] | null): BrowserDomNodeTrace[] | null {
  if (nodes === null) return null;
  return nodes.slice(0, maxDomNodes).map((node) => ({
    tag: /^[a-z][a-z0-9-]{0,31}$/u.test(node.tag) ? node.tag : "unknown",
    childElements: boundedCount(node.childElements),
    textCharacters: boundedCount(node.textCharacters),
  }));
}

export class BrowserFailureTraceStore {
  private readonly directory: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, "traces");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  record(input: BrowserFailureTraceInput): string {
    const id = randomUUID();
    const trace: BrowserFailureTrace = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      authorized: input.authorized,
      phase: input.phase,
      errorCode: input.errorCode,
      elapsedMs: boundedCount(input.elapsedMs),
      dom: input.authorized ? null : safeDom(input.dom),
      domCapture: input.authorized
        ? "omitted_authorized"
        : input.domCapture ?? (input.dom === null ? "unavailable" : "captured"),
      network: {
        observedEvents: boundedCount(input.network.observedEvents),
        failedRequests: boundedCount(input.network.failedRequests),
        resourceTypes: boundedCounters(input.network.resourceTypes, [
          "document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch",
          "websocket", "other",
        ]),
        statusClasses: boundedCounters(input.network.statusClasses, [
          "2xx", "3xx", "4xx", "5xx", "other",
        ]),
      },
      console: boundedCounters(input.console, [
        "debug", "log", "info", "warning", "error", "other",
      ]),
    };
    const serialized = JSON.stringify(trace);
    if (Buffer.byteLength(serialized) > maxTraceBytes) {
      throw new ReadError("INTERNAL_ERROR", "The bounded browser failure trace exceeded its limit.");
    }
    const path = join(this.directory, `${id}.json`);
    writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    this.prune();
    return `browser-trace:${id}`;
  }

  read(reference: string): BrowserFailureTrace {
    const match = traceReference.exec(reference);
    if (match?.[1] === undefined) {
      throw new ReadError("INVALID_ARGUMENT", "The browser trace reference is invalid.");
    }
    return JSON.parse(readFileSync(join(this.directory, `${match[1]}.json`), "utf8")) as BrowserFailureTrace;
  }

  private prune(): void {
    const files = readdirSync(this.directory)
      .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name))
      .map((name) => ({ name, modifiedAt: statSync(join(this.directory, name)).mtimeMs }))
      .sort((left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name));
    for (const file of files.slice(0, Math.max(0, files.length - maxTraceFiles))) {
      unlinkSync(join(this.directory, file.name));
    }
  }
}
