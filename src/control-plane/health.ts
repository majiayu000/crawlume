import { logEvent } from "../log.js";
import type { WorkerHttpRequest, WorkerHttpResponse } from "./organization-service.js";

const readinessTimeoutMs = 3_000;

type ReadinessDatabase = Readonly<{ query(statement: string): Promise<unknown> }>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): WorkerHttpResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body };
}

async function databaseAnswers(database: ReadinessDatabase, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The readiness query timed out.")), timeoutMs);
  });
  try {
    await Promise.race([database.query("SELECT 1"), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Unauthenticated probes outside `/v1`; they sit outside API metrics so polling does not skew them. */
export function withHealthChecks(
  api: Readonly<{ handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> }>,
  database: ReadinessDatabase,
  timeoutMs = readinessTimeoutMs,
): Readonly<{ handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> }> {
  return {
    handle: async (request) => {
      if (request.path !== "/healthz" && request.path !== "/readyz") return api.handle(request);
      if (request.method !== "GET") {
        return json(405, { status: "method_not_allowed" }, { allow: "GET" });
      }
      if (request.path === "/healthz") return json(200, { status: "ok" });
      try {
        await databaseAnswers(database, timeoutMs);
        return json(200, { status: "ready" });
      } catch (error) {
        logEvent("warn", "control_plane.readiness.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return json(503, { status: "unavailable" });
      }
    },
  };
}
