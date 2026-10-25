import { describe, expect, it } from "vitest";

import { ControlPlaneMetrics } from "../src/control-plane/control-metrics.js";

function database(row: Record<string, unknown>) {
  return { query: async <Row>() => ({ rows: [row as Row] }) };
}

const emptyState = {
  open_jobs: null, terminal_jobs: null, oldest_queued_seconds: null, active_leases: 0, overdue_leases: 0,
  workers: null, workers_with_session: 0, deliveries: null, oldest_pending_delivery_seconds: null,
  pending_uploads: 0, oldest_pending_upload_seconds: null, pending_deletions: 0,
  oldest_pending_deletion_seconds: null, live_artifact_bytes: 0,
};

describe("ControlPlaneMetrics", () => {
  it("reports zeros for every status family on an empty control plane", async () => {
    const text = await new ControlPlaneMetrics(database(emptyState)).prometheusText();
    expect(text).toContain('crawlume_control_jobs{status="queued"} 0');
    expect(text).toContain('crawlume_control_jobs_terminal_total{status="failed"} 0');
    expect(text).toContain("crawlume_control_oldest_queued_job_age_seconds 0");
    expect(text).toContain('crawlume_control_webhook_deliveries{status="dead_letter"} 0');
    expect(text).toContain("# TYPE crawlume_control_http_requests_total counter");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("renders control-plane state from the database", async () => {
    const text = await new ControlPlaneMetrics(database({
      ...emptyState,
      open_jobs: { queued: 3, running: 1 }, terminal_jobs: { completed: 10, failed: 2 },
      oldest_queued_seconds: 42.5, active_leases: 1, overdue_leases: 1, workers: { active: 2 },
      workers_with_session: 1, deliveries: { pending: 4, dead_letter: 1 }, oldest_pending_delivery_seconds: 90,
      pending_uploads: 2, oldest_pending_upload_seconds: 30, pending_deletions: 5,
      oldest_pending_deletion_seconds: 7_200, live_artifact_bytes: 1_048_576,
    })).prometheusText();
    for (const line of [
      'crawlume_control_jobs{status="queued"} 3',
      'crawlume_control_jobs{status="running"} 1',
      'crawlume_control_jobs_terminal_total{status="completed"} 10',
      'crawlume_control_jobs_terminal_total{status="failed"} 2',
      "crawlume_control_oldest_queued_job_age_seconds 42.5",
      "crawlume_control_overdue_leases 1",
      'crawlume_control_workers{status="active"} 2',
      "crawlume_control_workers_with_session 1",
      'crawlume_control_webhook_deliveries{status="pending"} 4',
      "crawlume_control_oldest_pending_webhook_delivery_age_seconds 90",
      "crawlume_control_pending_artifact_uploads 2",
      "crawlume_control_oldest_pending_artifact_deletion_age_seconds 7200",
      "crawlume_control_live_artifact_bytes 1048576",
    ]) expect(text).toContain(line);
  });

  it("counts instrumented responses by area, method and status class, including failures", async () => {
    let clock = 0;
    const metrics = new ControlPlaneMetrics(database(emptyState), () => clock);
    const api = metrics.instrument({
      handle: async (request: { path: string }) => {
        clock += 250;
        if (request.path.endsWith("/boom")) throw new Error("boom");
        return { status: request.path.includes("/jobs") ? 201 : 404, headers: {}, body: null };
      },
    });
    const request = (method: string, path: string) => ({ method, path, query: "", headers: {}, body: null });
    await api.handle(request("post", "/v1/projects/p/jobs"));
    await api.handle(request("POST", "/v1/projects/p/jobs"));
    await api.handle(request("GET", "/v1/projects/p/webhook-deliveries"));
    await expect(api.handle(request("POST", "/v1/job-leases/l/boom"))).rejects.toThrow("boom");
    const text = await metrics.prometheusText();
    expect(text).toContain('crawlume_control_http_requests_total{area="projects/jobs",method="POST",status_class="2xx"} 2');
    expect(text).toContain('crawlume_control_http_requests_total{area="projects/webhooks",method="GET",status_class="4xx"} 1');
    expect(text).toContain('crawlume_control_http_requests_total{area="job-leases",method="POST",status_class="5xx"} 1');
    expect(text).toContain('crawlume_control_http_request_duration_seconds_total{area="projects/jobs",method="POST",status_class="2xx"} 0.5');
  });

  it("fails visibly when the state query returns nothing", async () => {
    const metrics = new ControlPlaneMetrics({ query: async () => ({ rows: [] }) });
    await expect(metrics.prometheusText()).rejects.toThrow("returned no row");
  });
});
