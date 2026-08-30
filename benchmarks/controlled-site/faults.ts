import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { gzipSync } from "node:zlib";

import type { BenchmarkCase } from "../harness/contract.js";
import type { ReadErrorCode } from "../../src/errors.js";
import { listen } from "../harness/runtime.js";

export const controlledFaultScenarios = [
  "slow-header",
  "slow-body",
  "chunked-overflow",
  "redirect-chain",
  "retry-after-within-deadline",
  "retry-after-outside-deadline",
  "persistent-500",
  "static-article",
  "static-document",
  "json-document",
  "jsonld-article",
  "rss-feed",
  "atom-feed",
  "sitemap-document",
  "plain-document",
  "unicode-document",
  "navigation-noise",
  "large-article",
  "gzip-article",
  "pdf-document",
  "redirect-one",
  "redirect-relative",
  "retry-500-recovery",
  "retry-503-recovery",
  "bad-request",
  "unauthorized",
  "payment-required",
  "forbidden",
  "not-found",
  "gone",
  "rate-limited",
  "unavailable",
  "redirect-loop",
  "unsupported-image",
  "login-gate",
  "paywall-gate",
  "challenge-gate",
  "shell-no-browser",
  "error-template",
  "empty-page",
  "short-page",
  "robots-disallow",
  "js-shell-browser",
  "malformed-json",
  "wrong-mime-article",
  "content-type-missing",
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
  select(scenario: ControlledFaultScenario): void;
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
  errorCode: ReadErrorCode | null;
  expectedOutcome?: "failed" | "policy_stop" | "unsupported";
  maxAttempts: number;
  maxDurationMs: number;
  maxDocumentBytes: number;
  requestTimeoutMs: number;
  browserAllowed?: boolean;
  maxBrowserMs?: number;
};

const scenarioPolicies: Partial<Record<ControlledFaultScenario, ScenarioPolicy>> = {
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
  "retry-500-recovery": {
    errorCode: null,
    maxAttempts: 2,
    maxDurationMs: 2_000,
    maxDocumentBytes: 8_192,
    requestTimeoutMs: 500,
  },
  "retry-503-recovery": {
    errorCode: null,
    maxAttempts: 2,
    maxDurationMs: 2_000,
    maxDocumentBytes: 8_192,
    requestTimeoutMs: 500,
  },
  "bad-request": { errorCode: "ACCESS_DENIED", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "unauthorized": { errorCode: "AUTH_REQUIRED", expectedOutcome: "policy_stop", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "payment-required": { errorCode: "PAYMENT_REQUIRED", expectedOutcome: "policy_stop", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "forbidden": { errorCode: "ACCESS_DENIED", expectedOutcome: "policy_stop", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "not-found": { errorCode: "ACCESS_DENIED", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "gone": { errorCode: "ACCESS_DENIED", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "rate-limited": { errorCode: "RATE_LIMITED", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "unavailable": { errorCode: "UPSTREAM_ERROR", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "redirect-loop": { errorCode: "UPSTREAM_ERROR", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "unsupported-image": { errorCode: "UNSUPPORTED_CONTENT_TYPE", expectedOutcome: "unsupported", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "login-gate": { errorCode: "LOGIN_WALL_DETECTED", expectedOutcome: "policy_stop", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "paywall-gate": { errorCode: "PAYMENT_REQUIRED", expectedOutcome: "policy_stop", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "challenge-gate": { errorCode: "HUMAN_VERIFICATION_REQUIRED", expectedOutcome: "policy_stop", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "shell-no-browser": { errorCode: "SHELL_ONLY", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "error-template": { errorCode: "INCOMPLETE_CONTENT", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "empty-page": { errorCode: "INCOMPLETE_CONTENT", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "short-page": { errorCode: "INCOMPLETE_CONTENT", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "robots-disallow": { errorCode: "ROBOTS_DISALLOWED", expectedOutcome: "policy_stop", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
  "js-shell-browser": { errorCode: null, maxAttempts: 2, maxDurationMs: 10_000, maxDocumentBytes: 50_000, requestTimeoutMs: 1_000, browserAllowed: true, maxBrowserMs: 8_000 },
  "malformed-json": { errorCode: "INCOMPLETE_CONTENT", maxAttempts: 1, maxDurationMs: 1_000, maxDocumentBytes: 8_192, requestTimeoutMs: 500 },
};

const defaultScenarioPolicy: ScenarioPolicy = {
  errorCode: null,
  maxAttempts: 1,
  maxDurationMs: 2_000,
  maxDocumentBytes: 100_000,
  requestTimeoutMs: 1_000,
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

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/[()\\]/gu, (value) => `\\${value}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
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

function sitePath(scenario: ControlledFaultScenario): string {
  return `/__fault/${scenario}`;
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
  let selectedScenario: ControlledFaultScenario | null = null;

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
      response.end(selectedScenario === "robots-disallow"
        ? "User-agent: *\nDisallow: /__fault/robots-disallow\n"
        : "User-agent: *\nAllow: /\n");
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

    if (["static-article", "static-document", "large-article"].includes(scenario)) {
      html(response, articleHtml());
      return;
    }
    if (scenario === "unicode-document") {
      html(response, articleHtml().replace(marker, `${marker} 中文 Ελληνικά العربية हिन्दी 日本語`));
      return;
    }
    if (scenario === "navigation-noise") {
      html(response, articleHtml().replace("<body>", "<body><nav>NAVIGATION SECRET DO NOT EXTRACT</nav>"));
      return;
    }
    if (scenario === "json-document") {
      const body = JSON.stringify({ title: "Controlled JSON", marker, body: marker.repeat(20) });
      response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
      return;
    }
    if (scenario === "jsonld-article") {
      const data = JSON.stringify({ "@type": "Article", headline: "Controlled JSON-LD", articleBody: `${marker} `.repeat(20) });
      html(response, `<!doctype html><html><head><title>Controlled JSON-LD</title><script type="application/ld+json">${data}</script></head><body><article><h1>Controlled JSON-LD</h1><p>${marker} ${"evidence ".repeat(80)}</p></article></body></html>`);
      return;
    }
    if (scenario === "rss-feed") {
      const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>Controlled RSS</title><item><title>${marker}</title><link>${targetOrigin}/rss-item</link><description>${marker} ${"feed evidence ".repeat(30)}</description></item></channel></rss>`;
      response.writeHead(200, { "content-type": "application/rss+xml", "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
      return;
    }
    if (scenario === "atom-feed") {
      const body = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Controlled Atom</title><entry><title>${marker}</title><link href="${targetOrigin}/atom-item"/><content>${marker} ${"atom evidence ".repeat(30)}</content></entry></feed>`;
      response.writeHead(200, { "content-type": "application/atom+xml", "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
      return;
    }
    if (scenario === "sitemap-document") {
      const body = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${targetOrigin}/sitemap-one</loc></url><url><loc>${targetOrigin}/sitemap-two</loc></url></urlset>`;
      response.writeHead(200, { "content-type": "application/xml", "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
      return;
    }
    if (scenario === "plain-document") {
      const body = `${marker}\n${"Plain deterministic evidence. ".repeat(30)}`;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
      return;
    }
    if (scenario === "pdf-document") {
      const body = minimalPdf(`${marker} PDF evidence`);
      response.writeHead(200, { "content-type": "application/pdf", "content-length": String(body.byteLength) });
      response.end(body);
      return;
    }
    if (scenario === "gzip-article") {
      const body = gzipSync(articleHtml());
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip", "content-length": String(body.byteLength) });
      response.end(body);
      return;
    }
    if (scenario === "wrong-mime-article") {
      const body = `${marker}\n${"Wrong MIME but readable evidence. ".repeat(30)}`;
      response.writeHead(200, { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
      return;
    }
    if (scenario === "content-type-missing") {
      const body = articleHtml();
      response.writeHead(200, { "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
      return;
    }
    if (scenario === "redirect-one" || scenario === "redirect-relative") {
      if (requestUrl.pathname.endsWith("/final")) {
        html(response, articleHtml());
      } else {
        response.writeHead(302, { location: `./${scenario}/final` });
        response.end();
      }
      return;
    }
    if (scenario === "retry-500-recovery" || scenario === "retry-503-recovery") {
      if (attempts[scenario] === 1) {
        response.writeHead(scenario === "retry-500-recovery" ? 500 : 503, { "content-type": "text/plain" });
        response.end("temporary failure");
      } else {
        html(response, articleHtml());
      }
      return;
    }
    const statusByScenario: Partial<Record<ControlledFaultScenario, number>> = {
      "bad-request": 400,
      unauthorized: 401,
      "payment-required": 402,
      forbidden: 403,
      "not-found": 404,
      gone: 410,
      "rate-limited": 429,
      unavailable: 503,
    };
    const status = statusByScenario[scenario];
    if (status !== undefined) {
      response.writeHead(status, { "content-type": "text/plain", ...(status === 429 ? { "retry-after": "0" } : {}) });
      response.end(`controlled HTTP ${status}`);
      return;
    }
    if (scenario === "redirect-loop") {
      response.writeHead(302, { location: sitePath(scenario) });
      response.end();
      return;
    }
    if (scenario === "unsupported-image") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (scenario === "login-gate") {
      html(response, "<html><head><title>Sign in</title></head><body><form><input type=password><button>Sign in</button></form><a>Sign up</a></body></html>");
      return;
    }
    if (scenario === "paywall-gate") {
      html(response, `<html><head><title>Members only</title></head><body><main class="paywall"><h1>Members only</h1><p>Subscribe to continue reading.</p></main></body></html>`);
      return;
    }
    if (scenario === "challenge-gate") {
      html(response, "<html><head><title>Security verification</title></head><body><main><h1>Verify you are human</h1><p>Checking your browser</p></main></body></html>");
      return;
    }
    if (scenario === "shell-no-browser") {
      html(response, "<html><head><title>Loading</title></head><body><div>Loading...</div><script></script><script></script><script></script><script></script></body></html>");
      return;
    }
    if (scenario === "error-template") {
      html(response, "<html><head><title>404 Not Found</title></head><body><main><h1>404 Not Found</h1><p>Page not found</p></main></body></html>");
      return;
    }
    if (scenario === "empty-page") {
      html(response, "<html><head><title>Empty</title></head><body></body></html>");
      return;
    }
    if (scenario === "short-page") {
      html(response, "<html><head><title>Short</title></head><body><main><p>Too short.</p></main></body></html>");
      return;
    }
    if (scenario === "robots-disallow") {
      html(response, articleHtml());
      return;
    }
    if (scenario === "js-shell-browser") {
      const rendered = JSON.stringify(articleHtml());
      html(response, `<html><head><title>Loading</title></head><body><div>Loading...</div><script>setTimeout(function(){document.open();document.write(${rendered});document.close();},50)</script><script></script><script></script><script></script></body></html>`);
      return;
    }
    if (scenario === "malformed-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"marker":"${marker}",`);
      return;
    }

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
    select: (scenario) => {
      selectedScenario = scenario;
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
  const policy = scenarioPolicies[scenario] ?? defaultScenarioPolicy;
  const expectedFinalUrl = scenario === "redirect-chain" ||
      scenario === "redirect-one" || scenario === "redirect-relative"
    ? `${site.targetOrigin}/__fault/${scenario}/final`
    : site.urlFor(scenario);
  const required: BenchmarkCase["truth"]["required"] = policy.errorCode === null
    ? [
        { type: "outcome_equals", value: "ok" },
        { type: "contains_text", value: scenario === "sitemap-document" ? site.targetOrigin : marker },
        { type: "fetch_method_equals", value: scenario === "js-shell-browser" ? "browser" : "http" },
        ...(expectedFinalUrl !== site.urlFor(scenario)
          ? [{ type: "final_url_equals" as const, value: expectedFinalUrl }]
          : []),
      ]
    : [
        { type: "outcome_equals", value: policy.expectedOutcome ?? "failed" },
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
        browserAllowed: policy.browserAllowed ?? false,
        authProfile: null,
        maxAttempts: policy.maxAttempts,
        maxDurationMs: policy.maxDurationMs,
        maxDocumentBytes: policy.maxDocumentBytes,
        maxBrowserMs: policy.maxBrowserMs ?? 0,
      },
      truth: {
        required,
        forbidden: scenario === "navigation-noise"
          ? [{ type: "contains_text", value: "NAVIGATION SECRET DO NOT EXTRACT" }]
          : [],
      },
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
