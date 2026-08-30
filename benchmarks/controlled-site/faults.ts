import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type { BenchmarkCase } from "../harness/contract.js";
import { listen } from "../harness/runtime.js";

export const controlledFaultScenarios = [
  "slow-header",
  "slow-body",
  "chunked-overflow",
  "redirect-chain",
  "retry-after-within-deadline",
  "retry-after-outside-deadline",
  "persistent-500",
] as const;

export type ControlledFaultScenario = (typeof controlledFaultScenarios)[number];

export type ControlledFaultStats = {
  totalRequests: number;
  robotsRequests: number;
  scenarioRequests: Record<ControlledFaultScenario, number>;
};

export type ControlledFaultSite = {
  proxyUrl: string;
  targetOrigin: string;
  urlFor(scenario: ControlledFaultScenario): string;
  stats(): ControlledFaultStats;
  reset(): void;
  close(): Promise<void>;
};

export type ControlledFaultBenchmark = {
  benchmarkCase: BenchmarkCase;
  expectedFinalUrl: string;
  maxDocumentBytes: number;
  requestTimeoutMs: number;
  maxRedirects: number;
};

const targetOrigin = "http://example.com";
const marker = "CONTROLLED FAULT ARTICLE MARKER";

type ScenarioPolicy = {
  errorCode: "BUDGET_EXHAUSTED" | "FETCH_TIMEOUT" | "UPSTREAM_ERROR" | null;
  maxAttempts: number;
  maxDurationMs: number;
  maxDocumentBytes: number;
  requestTimeoutMs: number;
};

const scenarioPolicies: Record<ControlledFaultScenario, ScenarioPolicy> = {
  "slow-header": {
    errorCode: "FETCH_TIMEOUT",
    maxAttempts: 1,
    maxDurationMs: 5_000,
    maxDocumentBytes: 8_192,
    requestTimeoutMs: 1_500,
  },
  "slow-body": {
    errorCode: "FETCH_TIMEOUT",
    maxAttempts: 1,
    maxDurationMs: 5_000,
    maxDocumentBytes: 8_192,
    requestTimeoutMs: 1_500,
  },
  "chunked-overflow": {
    errorCode: "BUDGET_EXHAUSTED",
    maxAttempts: 1,
    maxDurationMs: 1_000,
    maxDocumentBytes: 1_024,
    requestTimeoutMs: 500,
  },
  "redirect-chain": {
    errorCode: null,
    maxAttempts: 1,
    maxDurationMs: 1_000,
    maxDocumentBytes: 8_192,
    requestTimeoutMs: 500,
  },
  "retry-after-within-deadline": {
    errorCode: null,
    maxAttempts: 2,
    maxDurationMs: 2_500,
    maxDocumentBytes: 8_192,
    requestTimeoutMs: 500,
  },
  "retry-after-outside-deadline": {
    errorCode: "BUDGET_EXHAUSTED",
    maxAttempts: 2,
    maxDurationMs: 300,
    maxDocumentBytes: 8_192,
    requestTimeoutMs: 200,
  },
  "persistent-500": {
    errorCode: "UPSTREAM_ERROR",
    maxAttempts: 3,
    maxDurationMs: 1_000,
    maxDocumentBytes: 8_192,
    requestTimeoutMs: 500,
  },
};

function emptyScenarioCounts(): Record<ControlledFaultScenario, number> {
  return Object.fromEntries(
    controlledFaultScenarios.map((scenario) => [scenario, 0]),
  ) as Record<ControlledFaultScenario, number>;
}

function clonedStats(stats: ControlledFaultStats): ControlledFaultStats {
  return {
    totalRequests: stats.totalRequests,
    robotsRequests: stats.robotsRequests,
    scenarioRequests: { ...stats.scenarioRequests },
  };
}

function articleHtml(): string {
  const paragraph = "This controlled article contains deterministic evidence, context, and enough meaningful text for production validation. ";
  return `<!doctype html><html><head><title>Controlled fault recovery</title></head><body><main><h1>Controlled fault recovery</h1><p>${marker}</p><p>${paragraph.repeat(12)}</p></main></body></html>`;
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function scenarioForPath(pathname: string): ControlledFaultScenario | null {
  return controlledFaultScenarios.find(
    (scenario) => pathname === `/__fault/${scenario}` ||
      pathname.startsWith(`/__fault/${scenario}/`),
  ) ?? null;
}

export async function createControlledFaultSite(): Promise<ControlledFaultSite> {
  let stats: ControlledFaultStats = {
    totalRequests: 0,
    robotsRequests: 0,
    scenarioRequests: emptyScenarioCounts(),
  };
  const attempts = emptyScenarioCounts();
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();

  const later = (milliseconds: number, action: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, milliseconds);
    timers.add(timer);
  };

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", targetOrigin);
    stats.totalRequests += 1;
    if (requestUrl.pathname === "/robots.txt") {
      stats.robotsRequests += 1;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("User-agent: *\nAllow: /\n");
      return;
    }

    const scenario = scenarioForPath(requestUrl.pathname);
    if (scenario === null) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("controlled route not found");
      return;
    }
    stats.scenarioRequests[scenario] += 1;
    attempts[scenario] += 1;

    if (scenario === "slow-header") {
      later(3_000, () => {
        if (!response.destroyed) html(response, articleHtml());
      });
      return;
    }
    if (scenario === "slow-body") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.write("<!doctype html><html><body><main><h1>Slow body</h1>");
      later(3_000, () => {
        if (!response.destroyed) response.end(`<p>${marker}</p></main></body></html>`);
      });
      return;
    }
    if (scenario === "chunked-overflow") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.write("<html><body><main>");
      response.write("x".repeat(2_048));
      response.end("</main></body></html>");
      return;
    }
    if (scenario === "redirect-chain") {
      const segment = requestUrl.pathname.split("/").at(-1);
      if (segment === "final") {
        html(response, articleHtml());
        return;
      }
      const step = segment === "redirect-chain" ? 0 : Number.parseInt(segment ?? "", 10);
      const location = step >= 2
        ? "/__fault/redirect-chain/final"
        : `/__fault/redirect-chain/${step + 1}`;
      response.writeHead(302, { location });
      response.end();
      return;
    }
    if (scenario === "retry-after-within-deadline") {
      if (attempts[scenario] === 1) {
        response.writeHead(429, {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": "1",
        });
        response.end("retry later");
      } else {
        html(response, articleHtml());
      }
      return;
    }
    if (scenario === "retry-after-outside-deadline") {
      response.writeHead(429, {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": "2",
      });
      response.end("retry after the deadline");
      return;
    }
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("persistent upstream failure");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const port = await listen(server);
  const proxyUrl = `http://127.0.0.1:${port}`;
  return {
    proxyUrl,
    targetOrigin,
    urlFor: (scenario) => `${targetOrigin}/__fault/${scenario}`,
    stats: () => clonedStats(stats),
    reset: () => {
      stats = { totalRequests: 0, robotsRequests: 0, scenarioRequests: emptyScenarioCounts() };
      for (const scenario of controlledFaultScenarios) attempts[scenario] = 0;
    },
    close: () => new Promise<void>((resolve, reject) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
  };
}

export function buildControlledFaultBenchmark(
  site: Pick<ControlledFaultSite, "targetOrigin" | "urlFor">,
  scenario: ControlledFaultScenario,
): ControlledFaultBenchmark {
  const policy = scenarioPolicies[scenario];
  const expectedFinalUrl = scenario === "redirect-chain"
    ? `${site.targetOrigin}/__fault/redirect-chain/final`
    : site.urlFor(scenario);
  const required: BenchmarkCase["truth"]["required"] = policy.errorCode === null
    ? [
        { type: "outcome_equals", value: "ok" },
        { type: "contains_text", value: marker },
        { type: "fetch_method_equals", value: "http" },
        ...(scenario === "redirect-chain"
          ? [{ type: "final_url_equals" as const, value: expectedFinalUrl }]
          : []),
      ]
    : [
        { type: "outcome_equals", value: "failed" },
        { type: "error_code_equals", value: policy.errorCode },
      ];
  return {
    benchmarkCase: {
      schemaVersion: 2,
      id: `controlled-${scenario}`,
      layer: "controlled",
      category: scenario,
      input: { url: site.urlFor(scenario), intent: "read", freshnessSeconds: 0 },
      policy: {
        browserAllowed: false,
        authProfile: null,
        maxAttempts: policy.maxAttempts,
        maxDurationMs: policy.maxDurationMs,
        maxBrowserMs: 0,
      },
      truth: { required, forbidden: [] },
      reviewedAt: "2026-08-30T00:00:00.000Z",
      expiresAt: null,
    },
    expectedFinalUrl,
    maxDocumentBytes: policy.maxDocumentBytes,
    requestTimeoutMs: policy.requestTimeoutMs,
    maxRedirects: 5,
  };
}

export function buildControlledFaultMatrix(
  site: Pick<ControlledFaultSite, "targetOrigin" | "urlFor">,
): ControlledFaultBenchmark[] {
  return controlledFaultScenarios.map((scenario) =>
    buildControlledFaultBenchmark(site, scenario)
  );
}

export function controlledFaultEnvironment(
  site: Pick<ControlledFaultSite, "proxyUrl">,
  dataDirectory: string,
  fixture: ControlledFaultBenchmark,
): Record<string, string> {
  if (dataDirectory.length === 0) throw new Error("dataDirectory must be non-empty");
  return {
    DIAOYAN_ALLOW_DNS_FAKE_IP: "1",
    DIAOYAN_CRAWL_MAX_RETRY_DELAY_MS: "5000",
    DIAOYAN_CRAWL_MIN_HOST_INTERVAL_MS: "0",
    DIAOYAN_CRAWL_RETRY_BASE_MS: "0",
    DIAOYAN_DATA_DIR: dataDirectory,
    DIAOYAN_MAX_REDIRECTS: String(fixture.maxRedirects),
    DIAOYAN_MAX_RESPONSE_BYTES: String(fixture.maxDocumentBytes),
    DIAOYAN_PROXY_URLS: site.proxyUrl,
    DIAOYAN_REQUEST_TIMEOUT_MS: String(fixture.requestTimeoutMs),
  };
}
