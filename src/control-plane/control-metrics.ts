import type { WorkerHttpRequest, WorkerHttpResponse } from "./organization-service.js";
import type { ControlPlaneQuery } from "./project-scope.js";

// Prometheus metrics for the control plane. State gauges are read from PostgreSQL on every scrape,
// so every instance reports the same values; HTTP counters are per process.

type StateRow = {
  open_jobs: Record<string, number> | null;
  terminal_jobs: Record<string, number> | null;
  oldest_queued_seconds: number | null;
  active_leases: number;
  overdue_leases: number;
  workers: Record<string, number> | null;
  workers_with_session: number;
  deliveries: Record<string, number> | null;
  oldest_pending_delivery_seconds: number | null;
  pending_uploads: number;
  oldest_pending_upload_seconds: number | null;
  pending_deletions: number;
  oldest_pending_deletion_seconds: number | null;
  live_artifact_bytes: number;
};

const openJobStatuses = ["accepted", "queued", "assigned", "running", "paused"] as const;
const terminalJobStatuses = ["completed", "failed", "cancelled"] as const;
const workerStatuses = ["active", "disabled"] as const;
const deliveryStatuses = ["pending", "succeeded", "dead_letter"] as const;

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

function area(path: string): string {
  const segment = path.split("/")[2] ?? "";
  if (segment === "projects") {
    const resource = path.split("/")[4] ?? "";
    return ["jobs", "api-keys", "audit-events", "artifacts", "worker-enrollments", "workers"].includes(resource) ||
      resource.startsWith("webhook-")
      ? `projects/${resource.startsWith("webhook-") ? "webhooks" : resource}`
      : "projects";
  }
  return ["auth", "organizations", "workers", "job-leases", "worker-sessions", "worker-enrollments"]
    .includes(segment) ? segment : "other";
}

export class ControlPlaneMetrics {
  private readonly requests = new Map<string, { count: number; seconds: number }>();

  constructor(
    private readonly database: ControlPlaneQuery,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Wraps an API so every response is counted by area, method and status class. */
  instrument<Api extends { handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> }>(api: Api): Api {
    return {
      ...api,
      handle: async (request: WorkerHttpRequest) => {
        const startedAt = this.now();
        let status = 500;
        try {
          const response = await api.handle(request);
          status = response.status;
          return response;
        } finally {
          const key = `${area(request.path)}\0${request.method.toUpperCase()}\0${Math.floor(status / 100)}xx`;
          const entry = this.requests.get(key) ?? { count: 0, seconds: 0 };
          entry.count += 1;
          entry.seconds += (this.now() - startedAt) / 1_000;
          this.requests.set(key, entry);
        }
      },
    };
  }

  async prometheusText(): Promise<string> {
    const startedAt = this.now();
    const result = await this.database.query<StateRow>(`
      WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
      SELECT
        (SELECT jsonb_object_agg(status, count) FROM (
          SELECT status, count(*)::int AS count FROM jobs
          WHERE status IN ('accepted', 'queued', 'assigned', 'running', 'paused') GROUP BY status
        ) AS grouped) AS open_jobs,
        (SELECT jsonb_object_agg(status, count) FROM (
          SELECT status, count(*)::int AS count FROM jobs
          WHERE status IN ('completed', 'failed', 'cancelled') GROUP BY status
        ) AS grouped) AS terminal_jobs,
        (SELECT EXTRACT(EPOCH FROM clock.now - min(created_at))::float8 FROM jobs
          WHERE status = 'queued' AND not_before <= clock.now) AS oldest_queued_seconds,
        (SELECT count(*)::int FROM job_leases WHERE status = 'active') AS active_leases,
        (SELECT count(*)::int FROM job_leases WHERE status = 'active'
          AND (heartbeat_deadline <= clock.now OR lease_deadline <= clock.now)) AS overdue_leases,
        (SELECT jsonb_object_agg(status, count) FROM (
          SELECT status, count(*)::int AS count FROM workers GROUP BY status
        ) AS grouped) AS workers,
        (SELECT count(DISTINCT worker_sessions.worker_id)::int FROM worker_sessions
          INNER JOIN workers ON workers.id = worker_sessions.worker_id AND workers.status = 'active'
          WHERE worker_sessions.revoked_at IS NULL AND worker_sessions.expires_at > clock.now)
          AS workers_with_session,
        (SELECT jsonb_object_agg(status, count) FROM (
          SELECT status, count(*)::int AS count FROM webhook_deliveries GROUP BY status
        ) AS grouped) AS deliveries,
        (SELECT EXTRACT(EPOCH FROM clock.now - min(created_at))::float8 FROM webhook_deliveries
          WHERE status = 'pending') AS oldest_pending_delivery_seconds,
        (SELECT count(*)::int FROM artifact_metadata
          WHERE storage_kind = 'cloud_object' AND uploaded_at IS NULL AND tombstoned_at IS NULL)
          AS pending_uploads,
        (SELECT EXTRACT(EPOCH FROM clock.now - min(created_at))::float8 FROM artifact_metadata
          WHERE storage_kind = 'cloud_object' AND uploaded_at IS NULL AND tombstoned_at IS NULL)
          AS oldest_pending_upload_seconds,
        (SELECT count(*)::int FROM artifact_metadata
          WHERE tombstoned_at IS NOT NULL AND object_deleted_at IS NULL) AS pending_deletions,
        (SELECT EXTRACT(EPOCH FROM clock.now - min(tombstoned_at))::float8 FROM artifact_metadata
          WHERE tombstoned_at IS NOT NULL AND object_deleted_at IS NULL) AS oldest_pending_deletion_seconds,
        (SELECT coalesce(sum(byte_count), 0)::float8 FROM artifact_metadata
          WHERE storage_kind = 'cloud_object' AND uploaded_at IS NOT NULL AND tombstoned_at IS NULL)
          AS live_artifact_bytes
      FROM clock
    `, []);
    const state = result.rows[0];
    if (state === undefined) throw new Error("Control-plane metrics query returned no row.");
    const lines: string[] = [];
    const family = (name: string, type: "gauge" | "counter", help: string, samples: Array<[string, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
    };
    const byStatus = (values: Record<string, number> | null, statuses: readonly string[]) =>
      statuses.map((status): [string, number] => [`{status="${status}"}`, values?.[status] ?? 0]);
    const age = (seconds: number | null): Array<[string, number]> => [["", seconds === null ? 0 : seconds]];

    family("crawlume_control_jobs", "gauge", "Jobs that are not yet terminal, by status.",
      byStatus(state.open_jobs, openJobStatuses));
    family("crawlume_control_jobs_terminal_total", "counter", "Jobs that reached a terminal status.",
      byStatus(state.terminal_jobs, terminalJobStatuses));
    family("crawlume_control_oldest_queued_job_age_seconds", "gauge",
      "Age of the oldest claimable queued Job; 0 when the queue is empty.", age(state.oldest_queued_seconds));
    family("crawlume_control_active_leases", "gauge", "Active Job leases.", [["", state.active_leases]]);
    family("crawlume_control_overdue_leases", "gauge",
      "Active leases past their heartbeat or lease deadline and not yet recovered.", [["", state.overdue_leases]]);
    family("crawlume_control_workers", "gauge", "Registered Workers by status.",
      byStatus(state.workers, workerStatuses));
    family("crawlume_control_workers_with_session", "gauge",
      "Active Workers holding an unexpired, unrevoked session.", [["", state.workers_with_session]]);
    family("crawlume_control_webhook_deliveries", "gauge", "Webhook deliveries by status.",
      byStatus(state.deliveries, deliveryStatuses));
    family("crawlume_control_oldest_pending_webhook_delivery_age_seconds", "gauge",
      "Age of the oldest pending webhook delivery; 0 when none.", age(state.oldest_pending_delivery_seconds));
    family("crawlume_control_pending_artifact_uploads", "gauge",
      "Published cloud Artifacts whose upload is not yet confirmed.", [["", state.pending_uploads]]);
    family("crawlume_control_oldest_pending_artifact_upload_age_seconds", "gauge",
      "Age of the oldest unconfirmed cloud Artifact upload; 0 when none.", age(state.oldest_pending_upload_seconds));
    family("crawlume_control_pending_artifact_deletions", "gauge",
      "Tombstoned cloud Artifacts whose object is not yet deleted.", [["", state.pending_deletions]]);
    family("crawlume_control_oldest_pending_artifact_deletion_age_seconds", "gauge",
      "Age of the oldest pending Artifact deletion; 0 when none.", age(state.oldest_pending_deletion_seconds));
    family("crawlume_control_live_artifact_bytes", "gauge",
      "Bytes of uploaded, non-tombstoned cloud Artifacts.", [["", state.live_artifact_bytes]]);

    const requestSamples = [...this.requests.entries()].sort(([left], [right]) => left.localeCompare(right));
    const requestLabels = (key: string) => {
      const [requestArea, method, statusClass] = key.split("\0") as [string, string, string];
      return `{area="${label(requestArea)}",method="${label(method)}",status_class="${statusClass}"}`;
    };
    family("crawlume_control_http_requests_total", "counter", "Control-plane API responses.",
      requestSamples.map(([key, entry]) => [requestLabels(key), entry.count]));
    family("crawlume_control_http_request_duration_seconds_total", "counter",
      "Total time spent handling control-plane API requests.",
      requestSamples.map(([key, entry]) => [requestLabels(key), entry.seconds]));
    family("crawlume_control_metrics_scrape_duration_seconds", "gauge",
      "Time spent reading control-plane state for this scrape.", [["", (this.now() - startedAt) / 1_000]]);
    return `${lines.join("\n")}\n`;
  }
}
