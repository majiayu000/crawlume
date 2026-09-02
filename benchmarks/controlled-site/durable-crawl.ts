import {
  createServer,
  request as forwardRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";

import { listen, positiveInteger } from "../harness/runtime.js";

export type DurableCrawlSiteOptions = {
  pages: number;
  bodyBytes?: number;
  holdPageResponses?: boolean;
  dynamicPages?: boolean;
  rateLimitPage?: number;
  retryAfterSeconds?: number;
  alternateSubdomainPages?: boolean;
};

export type DurableCrawlStats = {
  proxyRequests: number;
  robotsRequests: number;
  pageRequests: number;
  activePageRequests: number;
  peakActivePageRequests: number;
  requestsByPage: Record<string, number>;
  pageStartTimesMs: Record<string, number[]>;
  pageStartTimesByOrigin: Record<string, number[]>;
};

export type DurableCrawlSite = {
  proxyUrl: string;
  targetOrigin: string;
  seedUrl: string;
  stats(): DurableCrawlStats;
  waitForPageRequests(minimum: number, timeoutMs?: number): Promise<DurableCrawlStats>;
  releasePage(page: number): void;
  releaseAllPages(): void;
  setHoldPageResponses(hold: boolean): void;
  close(): Promise<void>;
};

type StatsWaiter = {
  minimum: number;
  resolve(value: DurableCrawlStats): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

const publicTargetOrigin = "http://example.com";

function cloneStats(stats: DurableCrawlStats): DurableCrawlStats {
  return {
    ...stats,
    requestsByPage: { ...stats.requestsByPage },
    pageStartTimesMs: Object.fromEntries(
      Object.entries(stats.pageStartTimesMs).map(([page, values]) => [page, [...values]]),
    ),
    pageStartTimesByOrigin: Object.fromEntries(
      Object.entries(stats.pageStartTimesByOrigin).map(([origin, values]) => [origin, [...values]]),
    ),
  };
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function forwardedHeaders(
  headers: IncomingHttpHeaders,
  originalOrigin: URL,
): IncomingHttpHeaders {
  const copied = { ...headers };
  delete copied["proxy-authorization"];
  delete copied["proxy-connection"];
  copied.host = originalOrigin.host;
  copied["x-durable-request-origin"] = originalOrigin.origin;
  return copied;
}

function pageHtml(
  runPath: string,
  page: number,
  pages: number,
  bodyBytes: number,
  dynamicPages: boolean,
  alternateSubdomainPages: boolean,
): string {
  const links = page === 0
    ? Array.from(
        { length: Math.max(0, pages - 1) },
        (_, index) => {
          const childPage = index + 1;
          const origin = alternateSubdomainPages
            ? `http://${childPage % 2 === 1 ? "a" : "b"}.example.com`
            : "";
          return `<a href="${origin}${runPath}/page/${childPage}">page-${childPage}</a>`;
        },
      ).join("\n")
    : [
        `<a href="${runPath}/page/0">root</a>`,
        `<a href="${runPath}/page/${page}#duplicate-fragment">same-page-fragment</a>`,
        `<a href="${runPath}/page/${page}?tracking=duplicate">same-page-query</a>`,
      ].join("\n");
  const sentence =
    `Durable controlled page ${page} contains deterministic crawler evidence and meaningful article text. `;
  const prefix =
    `<!doctype html><html><head><title>Durable page ${page}</title></head>` +
    `<body><main data-durable-page="${page}"><h1>Durable page ${page}</h1>` +
    `<p>DURABLE_CRAWL_MARKER_${page}</p><nav>${links}</nav><p>`;
  const suffix = "</p></main></body></html>";
  const minimumRepeats = 8;
  const remaining = Math.max(
    sentence.length * minimumRepeats,
    bodyBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix),
  );
  const rendered = `${prefix}${sentence.repeat(Math.ceil(remaining / sentence.length))}${suffix}`;
  if (!dynamicPages) return rendered;
  const payload = JSON.stringify(rendered.replace("<main ", "<main data-browser-ready=\"true\" "));
  return `<!doctype html><html><head><title>Loading durable page</title></head>` +
    `<body><div id="shell">Loading durable content</div><script>` +
    `setTimeout(function(){document.open();document.write(${payload});document.close();},30);` +
    `</script></body></html>`;
}

export async function createDurableCrawlSite(
  options: DurableCrawlSiteOptions,
): Promise<DurableCrawlSite> {
  const pages = positiveInteger(options.pages, "pages");
  const bodyBytes = positiveInteger(options.bodyBytes ?? 2_048, "bodyBytes");
  const runPath = `/__durable/${randomUUID()}`;
  const dynamicPages = options.dynamicPages ?? false;
  const alternateSubdomainPages = options.alternateSubdomainPages ?? false;
  const rateLimitPage = options.rateLimitPage;
  const retryAfterSeconds = positiveInteger(options.retryAfterSeconds ?? 1, "retryAfterSeconds");
  if (rateLimitPage !== undefined &&
      (!Number.isSafeInteger(rateLimitPage) || rateLimitPage < 0 || rateLimitPage >= pages)) {
    throw new Error(`rateLimitPage must be an integer between 0 and ${pages - 1}`);
  }
  let holdPageResponses = options.holdPageResponses ?? false;
  let closed = false;
  const held = new Map<number, Set<() => void>>();
  const targetSockets = new Set<Socket>();
  const proxySockets = new Set<Socket>();
  const waiters = new Set<StatsWaiter>();
  const stats: DurableCrawlStats = {
    proxyRequests: 0,
    robotsRequests: 0,
    pageRequests: 0,
    activePageRequests: 0,
    peakActivePageRequests: 0,
    requestsByPage: {},
    pageStartTimesMs: {},
    pageStartTimesByOrigin: {},
  };

  const settleWaiters = (): void => {
    for (const waiter of waiters) {
      if (stats.pageRequests < waiter.minimum) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(cloneStats(stats));
    }
  };

  const target = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", publicTargetOrigin);
    if (requestUrl.pathname === "/robots.txt") {
      stats.robotsRequests += 1;
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("User-agent: *\nAllow: /\n");
      return;
    }

    const pageMatch = new RegExp(`^${runPath}/page/(\\d+)$`, "u").exec(requestUrl.pathname);
    const page = Number.parseInt(pageMatch?.[1] ?? "", 10);
    if (!Number.isSafeInteger(page) || page < 0 || page >= pages) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("durable controlled route not found");
      return;
    }

    stats.pageRequests += 1;
    stats.activePageRequests += 1;
    stats.peakActivePageRequests = Math.max(
      stats.peakActivePageRequests,
      stats.activePageRequests,
    );
    const pageKey = String(page);
    const requestOrigin = typeof request.headers["x-durable-request-origin"] === "string"
      ? request.headers["x-durable-request-origin"]
      : publicTargetOrigin;
    stats.requestsByPage[pageKey] = (stats.requestsByPage[pageKey] ?? 0) + 1;
    (stats.pageStartTimesMs[pageKey] ??= []).push(Date.now());
    (stats.pageStartTimesByOrigin[requestOrigin] ??= []).push(Date.now());
    settleWaiters();

    let finished = false;
    const markFinished = (): void => {
      if (finished) return;
      finished = true;
      stats.activePageRequests -= 1;
    };
    response.once("finish", markFinished);
    response.once("close", markFinished);

    if (page === rateLimitPage) {
      response.writeHead(429, {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": String(retryAfterSeconds),
      });
      response.end("controlled rate limit");
      return;
    }

    const send = (): void => {
      if (response.destroyed || response.writableEnded) return;
      const body = pageHtml(
        runPath,
        page,
        pages,
        bodyBytes,
        dynamicPages,
        alternateSubdomainPages,
      );
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "text/html; charset=utf-8",
        "x-durable-page": pageKey,
      });
      response.end(body);
    };

    if (!holdPageResponses) {
      send();
      return;
    }
    const releases = held.get(page) ?? new Set<() => void>();
    releases.add(send);
    held.set(page, releases);
    response.once("close", () => {
      releases.delete(send);
      if (releases.size === 0) held.delete(page);
    });
  });
  target.on("connection", (socket) => {
    targetSockets.add(socket);
    socket.once("close", () => targetSockets.delete(socket));
  });
  const targetPort = await listen(target);

  const proxy = createServer((request, response) => {
    stats.proxyRequests += 1;
    let destination: URL;
    try {
      destination = new URL(request.url ?? "");
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("forward proxy requires an absolute request target");
      return;
    }
    let originalOrigin: URL;
    try {
      originalOrigin = new URL(`http://${request.headers.host ?? ""}`);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("forward proxy requires an original Host header");
      return;
    }
    const controlledHostname = originalOrigin.hostname === "example.com" ||
      originalOrigin.hostname.endsWith(".example.com");
    if (destination.protocol !== "http:" || destination.port !== "" || !controlledHostname) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("forward proxy target is outside the controlled origin");
      return;
    }

    const upstream = forwardRequest({
      host: "127.0.0.1",
      port: targetPort,
      method: request.method,
      path: `${destination.pathname}${destination.search}`,
      headers: forwardedHeaders(request.headers, originalOrigin),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (response.destroyed || response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("controlled upstream connection failed");
    });
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  });
  proxy.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });
  proxy.on("connection", (socket) => {
    proxySockets.add(socket);
    socket.once("close", () => proxySockets.delete(socket));
  });
  const proxyPort = await listen(proxy);

  const release = (page: number): void => {
    const releases = held.get(page);
    if (releases === undefined) return;
    held.delete(page);
    for (const send of releases) send();
  };

  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    targetOrigin: publicTargetOrigin,
    seedUrl: `${publicTargetOrigin}${runPath}/page/0`,
    stats: () => cloneStats(stats),
    waitForPageRequests(minimum, timeoutMs = 10_000) {
      positiveInteger(minimum, "minimum");
      positiveInteger(timeoutMs, "timeoutMs");
      if (stats.pageRequests >= minimum) return Promise.resolve(cloneStats(stats));
      if (closed) return Promise.reject(new Error("durable controlled site is closed"));
      return new Promise<DurableCrawlStats>((resolve, reject) => {
        const waiter: StatsWaiter = {
          minimum,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(
              `timed out waiting for ${minimum} page requests; observed ${stats.pageRequests}`,
            ));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    releasePage(page) {
      if (!Number.isSafeInteger(page) || page < 0 || page >= pages) {
        throw new Error(`page must be an integer between 0 and ${pages - 1}`);
      }
      release(page);
    },
    releaseAllPages() {
      for (const page of [...held.keys()]) release(page);
    },
    setHoldPageResponses(hold) {
      holdPageResponses = hold;
      if (!hold) {
        for (const page of [...held.keys()]) release(page);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("durable controlled site closed while awaiting requests"));
      }
      waiters.clear();
      for (const page of [...held.keys()]) release(page);
      await closeServer(proxy, proxySockets);
      await closeServer(target, targetSockets);
    },
  };
}
