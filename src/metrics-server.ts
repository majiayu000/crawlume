import { createServer, type Server } from "node:http";

/** Anything that can render Prometheus text, synchronously or after reading a database. */
export type PrometheusSource = Readonly<{ prometheusText(): string | Promise<string> }>;

export type MetricsListenerConfig = {
  host: string;
  port: number;
};

export type MetricsListener = {
  origin: string;
  close(): Promise<void>;
};

export function metricsListenerFromEnvironment(
  environment: NodeJS.ProcessEnv,
): MetricsListenerConfig | null {
  const rawPort = environment.CRAWLUME_METRICS_PORT;
  if (rawPort === undefined || rawPort === "") return null;
  const port = Number(rawPort);
  if (!/^(0|[1-9][0-9]{0,4})$/u.test(rawPort) || port > 65_535) {
    throw new Error("CRAWLUME_METRICS_PORT must be an integer between 0 and 65535.");
  }
  return { host: environment.CRAWLUME_METRICS_HOST?.trim() || "127.0.0.1", port };
}

export async function startMetricsListener(
  metrics: PrometheusSource,
  config: MetricsListenerConfig,
): Promise<MetricsListener> {
  const server: Server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
      return;
    }
    let body: string;
    try {
      body = await metrics.prometheusText();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        .end(`Metrics are unavailable: ${message}\n`);
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, config.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The metrics listener did not bind a TCP address.");
  }
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    origin: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    }),
  };
}
