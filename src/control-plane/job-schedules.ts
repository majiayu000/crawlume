import { randomUUID } from "node:crypto";

import { logEvent } from "../log.js";
import type { AuthenticatedProjectApiKey } from "./api-key-service.js";
import { nextCronTime, parseCronExpression } from "./cron.js";
import {
  assertExecutableJob,
  createJobBodySchema,
  jobCreationInput,
  type CreateJobBody,
} from "./job-request-wire.js";
import type { ControlPlaneDatabase, ControlPlaneJobService, ControlPlaneQuery } from "./project-scope.js";
import { StorageInputError, requireStorageName } from "./project-storage.js";

// Cron schedules that create Jobs from a stored request. Firing is fenced by the schedule row:
// one transaction locks a due row (SKIP LOCKED), creates the Job under the slot's idempotency key,
// and advances next_fire_at, so concurrent control-plane instances never fire a slot twice.

export class JobScheduleNotFoundError extends Error {
  readonly code = "JOB_SCHEDULE_NOT_FOUND";
  constructor() {
    super("The Job schedule does not exist in this Project.");
    this.name = "JobScheduleNotFoundError";
  }
}

export class JobScheduleConflictError extends Error {
  readonly code = "JOB_SCHEDULE_NAME_CONFLICT";
  constructor() {
    super("A Job schedule with this name already exists in the Project.");
    this.name = "JobScheduleConflictError";
  }
}

export type JobSchedule = Readonly<{
  id: string;
  name: string;
  cron: string;
  jobRequest: CreateJobBody;
  enabled: boolean;
  nextFireAt: Date;
  lastFiredAt: Date | null;
  lastJobId: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type JobScheduleRow = {
  id: string;
  project_id: string;
  name: string;
  cron: string;
  job_request: CreateJobBody;
  created_by_user_id: string;
  enabled: boolean;
  next_fire_at: Date;
  last_fired_at: Date | null;
  last_job_id: string | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
};

type DueScheduleRow = JobScheduleRow & { organization_id: string; database_now: Date };

type ProjectRef = Readonly<{ projectId: string }>;

const maxFiringsPerSweep = 100;

function jobSchedule(row: JobScheduleRow): JobSchedule {
  return Object.freeze({
    id: row.id, name: row.name, cron: row.cron, jobRequest: row.job_request, enabled: row.enabled,
    nextFireAt: row.next_fire_at, lastFiredAt: row.last_fired_at, lastJobId: row.last_job_id,
    lastErrorCode: row.last_error_code, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function nextFire(cron: string, after: Date): Date {
  const next = nextCronTime(parseCronExpression(cron), after);
  if (next === null) throw new StorageInputError("The cron expression never matches a date.");
  return next;
}

function errorCode(error: unknown): string {
  const code = error instanceof Error && "code" in error ? (error as { code: unknown }).code : null;
  return typeof code === "string" && /^[A-Z0-9_]{1,128}$/u.test(code) ? code : "JOB_CREATION_FAILED";
}

async function databaseNow(database: ControlPlaneQuery): Promise<Date> {
  const result = await database.query<{ now: Date }>("SELECT clock_timestamp() AS now", []);
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new Error("The schedule clock query returned no timestamp.");
  return now;
}

export class JobScheduleService {
  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly jobs: Pick<ControlPlaneJobService, "createJobInTransaction">,
  ) {}

  async create(
    identity: AuthenticatedProjectApiKey,
    input: Readonly<{ name: string; cron: string; jobRequest: unknown; enabled: boolean }>,
  ): Promise<JobSchedule> {
    requireStorageName(input.name, "name");
    const jobRequest = createJobBodySchema.parse(input.jobRequest);
    assertExecutableJob(jobRequest);
    if (jobRequest.not_before !== undefined) {
      throw new StorageInputError("Scheduled Job requests cannot set not_before.");
    }
    const cron = input.cron.trim().split(/\s+/u).join(" ");
    const nextFireAt = nextFire(cron, await databaseNow(this.database));
    const result = await this.database.query<JobScheduleRow>(`
      INSERT INTO job_schedules(id, project_id, name, cron, job_request, created_by_user_id, enabled, next_fire_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (project_id, name) DO NOTHING
      RETURNING *
    `, [
      randomUUID(), identity.projectId, input.name, cron, JSON.stringify(jobRequest),
      identity.createdByUserId, input.enabled, nextFireAt,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new JobScheduleConflictError();
    return jobSchedule(row);
  }

  async list(scope: ProjectRef): Promise<readonly JobSchedule[]> {
    const result = await this.database.query<JobScheduleRow>(`
      SELECT * FROM job_schedules WHERE project_id = $1 ORDER BY name
    `, [scope.projectId]);
    return result.rows.map(jobSchedule);
  }

  async get(scope: ProjectRef, scheduleId: string): Promise<JobSchedule> {
    const result = await this.database.query<JobScheduleRow>(`
      SELECT * FROM job_schedules WHERE id = $1 AND project_id = $2
    `, [scheduleId, scope.projectId]);
    const row = result.rows[0];
    if (row === undefined) throw new JobScheduleNotFoundError();
    return jobSchedule(row);
  }

  /** Enabling restarts from the next future slot, so slots missed while disabled never fire. */
  async setEnabled(scope: ProjectRef, scheduleId: string, enabled: boolean): Promise<JobSchedule> {
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<JobScheduleRow>(`
        SELECT * FROM job_schedules WHERE id = $1 AND project_id = $2 FOR UPDATE
      `, [scheduleId, scope.projectId]);
      const row = locked.rows[0];
      if (row === undefined) throw new JobScheduleNotFoundError();
      if (row.enabled === enabled) return jobSchedule(row);
      const nextFireAt = enabled ? nextFire(row.cron, await databaseNow(transaction)) : row.next_fire_at;
      const updated = await transaction.query<JobScheduleRow>(`
        UPDATE job_schedules SET enabled = $3, next_fire_at = $4, updated_at = clock_timestamp()
        WHERE id = $1 AND project_id = $2
        RETURNING *
      `, [scheduleId, scope.projectId, enabled, nextFireAt]);
      return jobSchedule(updated.rows[0] as JobScheduleRow);
    });
  }

  async delete(scope: ProjectRef, scheduleId: string): Promise<void> {
    const result = await this.database.query<{ id: string }>(`
      DELETE FROM job_schedules WHERE id = $1 AND project_id = $2 RETURNING id
    `, [scheduleId, scope.projectId]);
    if (result.rows[0] === undefined) throw new JobScheduleNotFoundError();
  }

  /** Fires every due schedule once; a schedule that fell behind fires once and skips missed slots. */
  async sweep(): Promise<number> {
    let fired = 0;
    while (fired < maxFiringsPerSweep && await this.fireNextDue()) fired += 1;
    return fired;
  }

  private async fireNextDue(): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const due = await transaction.query<DueScheduleRow>(`
        WITH execution_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
        SELECT job_schedules.*, projects.organization_id, execution_clock.now AS database_now
        FROM job_schedules
        INNER JOIN projects ON projects.id = job_schedules.project_id
        CROSS JOIN execution_clock
        WHERE job_schedules.enabled AND job_schedules.next_fire_at <= execution_clock.now
        ORDER BY job_schedules.next_fire_at, job_schedules.id
        FOR UPDATE OF job_schedules SKIP LOCKED
        LIMIT 1
      `, []);
      const row = due.rows[0];
      if (row === undefined) return false;
      const slot = row.next_fire_at;
      const creator = {
        userId: row.created_by_user_id, projectId: row.project_id, organizationId: row.organization_id,
      };
      let jobId: string | null = null;
      let failure: string | null = null;
      await transaction.query("SAVEPOINT schedule_fire", []);
      try {
        const job = await this.jobs.createJobInTransaction(
          transaction, creator, `schedule:${row.id}:${slot.toISOString()}`,
          jobCreationInput(createJobBodySchema.parse(row.job_request)), { correlationId: randomUUID() },
        );
        jobId = job.id;
        await transaction.query("RELEASE SAVEPOINT schedule_fire", []);
      } catch (error) {
        await transaction.query("ROLLBACK TO SAVEPOINT schedule_fire", []);
        failure = errorCode(error);
        logEvent("warn", "control_plane.schedule.fire_failed", { scheduleId: row.id, code: failure });
      }
      const next = nextCronTime(parseCronExpression(row.cron), row.database_now);
      await transaction.query(`
        UPDATE job_schedules SET next_fire_at = COALESCE($3, next_fire_at), enabled = $3 IS NOT NULL,
          last_fired_at = $4, last_job_id = COALESCE($5, last_job_id), last_error_code = $6,
          updated_at = $4
        WHERE id = $1 AND project_id = $2
      `, [row.id, row.project_id, next, row.database_now, jobId, failure]);
      return true;
    });
  }
}
