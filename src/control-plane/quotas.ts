import type { ControlPlaneQuery } from "./project-scope.js";

/** Per-Project limits applied to every Project; null means unlimited. */
export type ProjectQuotaLimits = Readonly<{
  activeJobs: number | null;
  monthlyProviderAttempts: number | null;
  monthlyBrowserMs: number | null;
  artifactBytes: number | null;
  apiRequestsPerMinute: number | null;
}>;

export type ProjectQuotaName = keyof ProjectQuotaLimits;

export const unlimitedProjectQuotas: ProjectQuotaLimits = Object.freeze({
  activeJobs: null,
  monthlyProviderAttempts: null,
  monthlyBrowserMs: null,
  artifactBytes: null,
  apiRequestsPerMinute: null,
});

export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";

  constructor(
    readonly quota: ProjectQuotaName,
    readonly limit: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`The Project ${quota} quota of ${limit} is exhausted.`);
    this.name = "QuotaExceededError";
  }
}

function quotaValue(environment: NodeJS.ProcessEnv, name: string, scale = 1): number | null {
  const raw = environment[name];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value * scale)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value * scale;
}

export function projectQuotasFromEnvironment(environment: NodeJS.ProcessEnv): ProjectQuotaLimits {
  return Object.freeze({
    activeJobs: quotaValue(environment, "DIAOYAN_QUOTA_ACTIVE_JOBS"),
    monthlyProviderAttempts: quotaValue(environment, "DIAOYAN_QUOTA_MONTHLY_PROVIDER_ATTEMPTS"),
    monthlyBrowserMs: quotaValue(environment, "DIAOYAN_QUOTA_MONTHLY_BROWSER_MINUTES", 60_000),
    artifactBytes: quotaValue(environment, "DIAOYAN_QUOTA_ARTIFACT_BYTES"),
    apiRequestsPerMinute: quotaValue(environment, "DIAOYAN_QUOTA_API_REQUESTS_PER_MINUTE"),
  });
}

type QuotaUsageRow = {
  active_jobs: string;
  reserved_provider_attempts: string;
  reserved_browser_ms: string;
  artifact_bytes: string;
};

function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function secondsUntilNextUtcMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1_000));
}

export function hasJobCreationQuotas(limits: ProjectQuotaLimits): boolean {
  return limits.activeJobs !== null || limits.monthlyProviderAttempts !== null ||
    limits.monthlyBrowserMs !== null || limits.artifactBytes !== null;
}

/**
 * Checks a new Job against the Project quotas inside the creating transaction. Monthly quotas count
 * the budgets reserved by Jobs created within [UTC month start, next UTC month start),
 * not execution usage metered during that month.
 * Caller holds the per-Project advisory lock and supplies clock_timestamp() read after locking.
 * Artifact bytes is a creation admission check, not a hard storage-write limit.
 */
export async function enforceJobCreationQuotas(
  transaction: ControlPlaneQuery,
  projectId: string,
  budget: Readonly<{ maxProviderAttempts: number; maxBrowserMs: number }>,
  limits: ProjectQuotaLimits,
  now: Date,
): Promise<void> {
  if (!hasJobCreationQuotas(limits)) return;
  const result = await transaction.query<QuotaUsageRow>(`
    SELECT
      ${limits.activeJobs === null ? "0" : `(SELECT count(*) FROM jobs
        WHERE project_id = $1
          AND status IN ('accepted', 'queued', 'assigned', 'running', 'paused'))`}::text AS active_jobs,
      ${limits.monthlyProviderAttempts === null ? "0" : `(SELECT coalesce(sum(budget_max_provider_attempts), 0) FROM jobs
        WHERE project_id = $1 AND created_at >= $2 AND created_at < $3)`}::text AS reserved_provider_attempts,
      ${limits.monthlyBrowserMs === null ? "0" : `(SELECT coalesce(sum(budget_max_browser_ms), 0) FROM jobs
        WHERE project_id = $1 AND created_at >= $2 AND created_at < $3)`}::text AS reserved_browser_ms,
      ${limits.artifactBytes === null ? "0" : `(SELECT coalesce(sum(byte_count), 0) FROM artifact_metadata
        WHERE project_id = $1 AND storage_kind = 'cloud_object' AND tombstoned_at IS NULL)`}::text AS artifact_bytes
  `, limits.monthlyProviderAttempts !== null || limits.monthlyBrowserMs !== null
    ? [projectId, utcMonthStart(now), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))]
    : [projectId]);
  const usage = result.rows[0];
  if (usage === undefined) throw new Error("Project quota usage query returned no row.");
  const monthReset = secondsUntilNextUtcMonth(now);
  if (limits.activeJobs !== null && Number(usage.active_jobs) + 1 > limits.activeJobs) {
    throw new QuotaExceededError("activeJobs", limits.activeJobs, null);
  }
  if (limits.monthlyProviderAttempts !== null &&
      Number(usage.reserved_provider_attempts) + budget.maxProviderAttempts > limits.monthlyProviderAttempts) {
    throw new QuotaExceededError("monthlyProviderAttempts", limits.monthlyProviderAttempts, monthReset);
  }
  if (limits.monthlyBrowserMs !== null &&
      Number(usage.reserved_browser_ms) + budget.maxBrowserMs > limits.monthlyBrowserMs) {
    throw new QuotaExceededError("monthlyBrowserMs", limits.monthlyBrowserMs, monthReset);
  }
  if (limits.artifactBytes !== null && Number(usage.artifact_bytes) >= limits.artifactBytes) {
    throw new QuotaExceededError("artifactBytes", limits.artifactBytes, null);
  }
}

/** Fixed one-minute window per API key. Counts are per control-plane process. */
export class ApiRequestRateLimiter {
  private readonly counts = new Map<string, number>();
  private windowStart: number | undefined;

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(apiKeyId: string): void {
    const now = this.now();
    const windowStart = now - (now % 60_000);
    if (this.windowStart !== windowStart) {
      this.counts.clear();
      this.windowStart = windowStart;
    }
    const current = this.counts.get(apiKeyId) ?? 0;
    if (current >= this.limitPerMinute) {
      throw new QuotaExceededError(
        "apiRequestsPerMinute",
        this.limitPerMinute,
        Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1_000)),
      );
    }
    this.counts.set(apiKeyId, current + 1);
  }
}
