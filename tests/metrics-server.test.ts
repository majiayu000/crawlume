import { afterEach, describe, expect, it } from "vitest";

import {
  metricsListenerFromEnvironment,
  startMetricsListener,
  type MetricsListener,
} from "../src/metrics-server.js";

const listeners: MetricsListener[] = [];

afterEach(async () => {
  while (listeners.length > 0) await listeners.pop()?.close();
});

describe("metrics listener", () => {
  it("is disabled unless a port is configured", () => {
    expect(metricsListenerFromEnvironment({})).toBeNull();
    expect(metricsListenerFromEnvironment({ CRAWLUME_METRICS_PORT: "9464" }))
      .toEqual({ host: "127.0.0.1", port: 9464 });
    expect(metricsListenerFromEnvironment({
      CRAWLUME_METRICS_PORT: "9464",
      CRAWLUME_METRICS_HOST: "0.0.0.0",
    })).toEqual({ host: "0.0.0.0", port: 9464 });
  });

  it("rejects an invalid port instead of silently disabling metrics", () => {
    expect(() => metricsListenerFromEnvironment({ CRAWLUME_METRICS_PORT: "metrics" }))
      .toThrow("CRAWLUME_METRICS_PORT");
    expect(() => metricsListenerFromEnvironment({ CRAWLUME_METRICS_PORT: "70000" }))
      .toThrow("CRAWLUME_METRICS_PORT");
  });

  it("serves Prometheus text on GET /metrics and 404 elsewhere", async () => {
    const listener = await startMetricsListener(
      { prometheusText: () => "crawlume_reads_total 1\n" },
      { host: "127.0.0.1", port: 0 },
    );
    listeners.push(listener);

    const metrics = await fetch(`${listener.origin}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    expect(await metrics.text()).toBe("crawlume_reads_total 1\n");

    expect((await fetch(`${listener.origin}/`)).status).toBe(404);
    expect((await fetch(`${listener.origin}/metrics`, { method: "POST" })).status).toBe(404);
  });

  it("reports a metrics read failure as a server error", async () => {
    const listener = await startMetricsListener(
      { prometheusText: () => { throw new Error("database is locked"); } },
      { host: "127.0.0.1", port: 0 },
    );
    listeners.push(listener);

    const response = await fetch(`${listener.origin}/metrics`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("database is locked");
  });
});
