import { z } from "zod";

import { requireProjectApiKeyScope, type AuthenticatedProjectApiKey } from "./api-key-service.js";
import type { JobSchedule, JobScheduleService } from "./job-schedules.js";
import type { WorkerHttpRequest } from "./organization-service.js";
import { scheduleRouteDefinitions } from "./router-contract.js";
import {
  matchProjectSubRoute,
  singleQueryValues,
  type ProjectSubRoute,
  type ProjectSubRouteResult,
} from "./storage-http.js";

export type ScheduleHttpServices = Pick<JobScheduleService, "create" | "list" | "get" | "setEnabled" | "delete">;

const createScheduleSchema = z.object({
  name: z.string(),
  cron: z.string().min(1).max(128),
  job: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
}).strict();
const emptyBodySchema = z.object({}).strict();

export function matchScheduleRoute(path: string, method: string) {
  return matchProjectSubRoute(scheduleRouteDefinitions, path, method);
}

function wireSchedule(schedule: JobSchedule): Record<string, unknown> {
  return {
    id: schedule.id, name: schedule.name, cron: schedule.cron, timezone: "UTC", job: schedule.jobRequest,
    enabled: schedule.enabled, next_fire_at: schedule.nextFireAt.toISOString(),
    last_fired_at: schedule.lastFiredAt?.toISOString() ?? null, last_job_id: schedule.lastJobId,
    last_error_code: schedule.lastErrorCode, created_at: schedule.createdAt.toISOString(),
    updated_at: schedule.updatedAt.toISOString(),
  };
}

/** Runs an authenticated schedule route: listing needs results:read, changes need tasks:write. */
export async function handleScheduleRoute(
  services: ScheduleHttpServices,
  route: ProjectSubRoute<(typeof scheduleRouteDefinitions)[number]["kind"]>,
  identity: AuthenticatedProjectApiKey,
  request: WorkerHttpRequest,
): Promise<ProjectSubRouteResult> {
  singleQueryValues(request.query ?? "", []);
  const read = route.kind === "list" || route.kind === "get";
  requireProjectApiKeyScope(identity, read ? "results:read" : "tasks:write");
  const scheduleId = route.parameters[0] ?? "";
  switch (route.kind) {
    case "create": {
      const parsed = createScheduleSchema.parse(request.body);
      const schedule = await services.create(identity, {
        name: parsed.name, cron: parsed.cron, jobRequest: parsed.job, enabled: parsed.enabled ?? true,
      });
      return {
        status: 201,
        body: { schedule: wireSchedule(schedule) },
        headers: { location: `/v1/projects/${identity.projectId}/schedules/${schedule.id}` },
      };
    }
    case "list":
      return { status: 200, body: { schedules: (await services.list(identity)).map(wireSchedule) } };
    case "get":
      return { status: 200, body: { schedule: wireSchedule(await services.get(identity, scheduleId)) } };
    case "enable":
    case "disable":
      emptyBodySchema.parse(request.body);
      return {
        status: 200,
        body: { schedule: wireSchedule(await services.setEnabled(identity, scheduleId, route.kind === "enable")) },
      };
    case "delete":
      await services.delete(identity, scheduleId);
      return { status: 204, body: null };
  }
}
