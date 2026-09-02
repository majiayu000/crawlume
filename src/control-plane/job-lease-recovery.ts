import type { ControlPlaneDatabase, ControlPlaneQuery } from "./project-scope.js";

export class ControlPlaneJobLeaseSweeper {
  private readonly now: () => Date;

  constructor(
    private readonly database: ControlPlaneDatabase,
    dependencies: Readonly<{ now?: () => Date }> = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async sweep(): Promise<number> {
    const now = this.now();
    return this.database.transaction((transaction) =>
      recoverExpiredJobLeases(transaction, null, now)
    );
  }
}

export async function recoverExpiredJobLeases(
  transaction: ControlPlaneQuery,
  projectId: string | null,
  now: Date,
): Promise<number> {
  const recovered = await transaction.query<{ id: string }>(`
    WITH candidates AS (
      SELECT leases.id, leases.project_id, leases.job_id, leases.generation
      FROM job_leases AS leases
      WHERE ($1::uuid IS NULL OR leases.project_id = $1)
        AND leases.status = 'active'
        AND (leases.heartbeat_deadline <= $2 OR leases.lease_deadline <= $2)
        AND NOT EXISTS (
          SELECT 1 FROM job_leases AS newer
          WHERE newer.project_id = leases.project_id AND newer.job_id = leases.job_id
            AND newer.generation > leases.generation
        )
      ORDER BY leases.heartbeat_deadline, leases.id
      FOR UPDATE OF leases SKIP LOCKED
    ), expired AS (
      UPDATE job_leases AS leases SET status = 'expired', finished_at = $2
      FROM candidates
      WHERE leases.id = candidates.id AND leases.project_id = candidates.project_id
        AND leases.job_id = candidates.job_id AND leases.generation = candidates.generation
        AND leases.status = 'active'
        AND (leases.heartbeat_deadline <= $2 OR leases.lease_deadline <= $2)
        AND NOT EXISTS (
          SELECT 1 FROM job_leases AS newer
          WHERE newer.project_id = leases.project_id AND newer.job_id = leases.job_id
            AND newer.generation > leases.generation
        )
      RETURNING leases.job_id, leases.project_id
    )
    UPDATE jobs SET
      status = CASE WHEN jobs.deadline_at <= $2 THEN 'failed' ELSE 'queued' END,
      error_code = CASE WHEN jobs.deadline_at <= $2 THEN 'JOB_DEADLINE_EXCEEDED' ELSE NULL END,
      completed_at = CASE WHEN jobs.deadline_at <= $2 THEN $2 ELSE NULL END,
      updated_at = $2
    FROM expired
    WHERE jobs.id = expired.job_id AND jobs.project_id = expired.project_id
      AND jobs.status IN ('assigned', 'running')
    RETURNING jobs.id
  `, [projectId, now]);
  await transaction.query<{ id: string }>(`
    UPDATE jobs SET status = 'failed', error_code = 'JOB_DEADLINE_EXCEEDED',
      completed_at = $2, updated_at = $2
    WHERE ($1::uuid IS NULL OR jobs.project_id = $1)
      AND jobs.status = 'queued' AND jobs.deadline_at <= $2
    RETURNING id
  `, [projectId, now]);
  return recovered.rows.length;
}
