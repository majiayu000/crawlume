const uuidPath =
  "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})";

export const projectJobRouteDefinitions = [
  {
    kind: "create",
    method: "POST",
    path: "/projects/{project_id}/jobs",
    operationId: "createProjectJob",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/jobs$`, "u"),
  },
  {
    kind: "get",
    method: "GET",
    path: "/projects/{project_id}/jobs/{job_id}",
    operationId: "getProjectJob",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/jobs/${uuidPath}$`, "u"),
  },
  {
    kind: "pause",
    method: "POST",
    path: "/projects/{project_id}/jobs/{job_id}/pause",
    operationId: "pauseProjectJob",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/jobs/${uuidPath}/pause$`, "u"),
  },
  {
    kind: "resume",
    method: "POST",
    path: "/projects/{project_id}/jobs/{job_id}/resume",
    operationId: "resumeProjectJob",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/jobs/${uuidPath}/resume$`, "u"),
  },
  {
    kind: "cancel",
    method: "POST",
    path: "/projects/{project_id}/jobs/{job_id}/cancel",
    operationId: "cancelProjectJob",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/jobs/${uuidPath}/cancel$`, "u"),
  },
  {
    kind: "publications",
    method: "GET",
    path: "/projects/{project_id}/jobs/{job_id}/publications",
    operationId: "listProjectJobPublications",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/jobs/${uuidPath}/publications$`, "u"),
  },
  {
    kind: "audit",
    method: "GET",
    path: "/projects/{project_id}/audit-events",
    operationId: "listProjectAuditEvents",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/audit-events$`, "u"),
  },
] as const;

export const projectJobRouterOperations = projectJobRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

export const projectApiKeyRouteDefinitions = [
  {
    kind: "collection",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/api-keys$`, "u"),
    methods: ["GET", "POST"],
    operations: [
      {
        method: "POST",
        path: "/projects/{project_id}/api-keys",
        operationId: "createProjectApiKey",
      },
      {
        method: "GET",
        path: "/projects/{project_id}/api-keys",
        operationId: "listProjectApiKeys",
      },
    ],
  },
  {
    kind: "item",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/api-keys/${uuidPath}$`, "u"),
    methods: ["DELETE"],
    operations: [{
      method: "DELETE",
      path: "/projects/{project_id}/api-keys/{key_id}",
      operationId: "revokeProjectApiKey",
    }],
  },
] as const;

export const workerRouteDefinitions = [
  {
    pattern: new RegExp(`^/v1/workers/${uuidPath}/claims$`, "u"),
    kind: "claim",
    method: "POST",
    path: "/workers/{worker_id}/claims",
    operationId: "claimWorkerJob",
  },
  {
    pattern: new RegExp(`^/v1/job-leases/${uuidPath}$`, "u"),
    kind: "heartbeat",
    method: "PATCH",
    path: "/job-leases/{lease_id}",
    operationId: "heartbeatJobLease",
  },
  {
    pattern: new RegExp(`^/v1/job-leases/${uuidPath}/events$`, "u"),
    kind: "event",
    method: "POST",
    path: "/job-leases/{lease_id}/events",
    operationId: "appendJobEvent",
  },
  {
    pattern: new RegExp(`^/v1/job-leases/${uuidPath}/publications$`, "u"),
    kind: "publication",
    method: "POST",
    path: "/job-leases/{lease_id}/publications",
    operationId: "publishJobResult",
  },
  {
    pattern: new RegExp(`^/v1/job-leases/${uuidPath}/complete$`, "u"),
    kind: "complete",
    method: "POST",
    path: "/job-leases/{lease_id}/complete",
    operationId: "completeJobLease",
  },
] as const;

export const workerRouterOperations = workerRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

export const controlPlaneRouterOperations = Object.freeze([
  ...projectJobRouterOperations,
  ...workerRouterOperations,
]);
