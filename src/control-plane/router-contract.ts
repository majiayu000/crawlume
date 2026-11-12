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
    kind: "artifact-download",
    method: "GET",
    path: "/projects/{project_id}/artifacts/{artifact_id}/download",
    operationId: "getProjectArtifactDownload",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/artifacts/${uuidPath}/download$`, "u"),
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

export const webhookRouteDefinitions = [
  {
    kind: "create-endpoint", method: "POST", path: "/projects/{project_id}/webhook-endpoints",
    operationId: "createWebhookEndpoint",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/webhook-endpoints$`, "u"),
  },
  {
    kind: "list-endpoints", method: "GET", path: "/projects/{project_id}/webhook-endpoints",
    operationId: "listWebhookEndpoints",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/webhook-endpoints$`, "u"),
  },
  {
    kind: "disable-endpoint", method: "DELETE",
    path: "/projects/{project_id}/webhook-endpoints/{endpoint_id}",
    operationId: "disableWebhookEndpoint",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/webhook-endpoints/${uuidPath}$`, "u"),
  },
  {
    kind: "rotate-secret", method: "POST",
    path: "/projects/{project_id}/webhook-endpoints/{endpoint_id}/rotate-secret",
    operationId: "rotateWebhookEndpointSecret",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/webhook-endpoints/${uuidPath}/rotate-secret$`, "u"),
  },
  {
    kind: "redeliver-event", method: "POST",
    path: "/projects/{project_id}/webhook-events/{event_id}/redeliver",
    operationId: "redeliverWebhookEvent",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/webhook-events/${uuidPath}/redeliver$`, "u"),
  },
  {
    kind: "list-deliveries", method: "GET", path: "/projects/{project_id}/webhook-deliveries",
    operationId: "listWebhookDeliveries",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/webhook-deliveries$`, "u"),
  },
] as const;

export const webhookRouterOperations = webhookRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

const storageNamePath = "([a-z0-9][a-z0-9-]{0,62})";
const recordKeyPath = "([A-Za-z0-9!._'()*-]{1,256})";
const datasetsPath = `^/v1/projects/${uuidPath}/datasets`;
const storesPath = `^/v1/projects/${uuidPath}/key-value-stores`;

export const storageRouteDefinitions = [
  {
    kind: "list-datasets", method: "GET", path: "/projects/{project_id}/datasets",
    operationId: "listDatasets", pattern: new RegExp(`${datasetsPath}$`, "u"),
  },
  {
    kind: "get-dataset", method: "GET", path: "/projects/{project_id}/datasets/{dataset_name}",
    operationId: "getDataset", pattern: new RegExp(`${datasetsPath}/${storageNamePath}$`, "u"),
  },
  {
    kind: "append-items", method: "POST", path: "/projects/{project_id}/datasets/{dataset_name}/items",
    operationId: "appendDatasetItems", pattern: new RegExp(`${datasetsPath}/${storageNamePath}/items$`, "u"),
  },
  {
    kind: "list-items", method: "GET", path: "/projects/{project_id}/datasets/{dataset_name}/items",
    operationId: "listDatasetItems", pattern: new RegExp(`${datasetsPath}/${storageNamePath}/items$`, "u"),
  },
  {
    kind: "export-items", method: "GET", path: "/projects/{project_id}/datasets/{dataset_name}/export",
    operationId: "exportDatasetItems", pattern: new RegExp(`${datasetsPath}/${storageNamePath}/export$`, "u"),
  },
  {
    kind: "list-stores", method: "GET", path: "/projects/{project_id}/key-value-stores",
    operationId: "listKeyValueStores", pattern: new RegExp(`${storesPath}$`, "u"),
  },
  {
    kind: "list-records", method: "GET", path: "/projects/{project_id}/key-value-stores/{store_name}/records",
    operationId: "listKeyValueRecords", pattern: new RegExp(`${storesPath}/${storageNamePath}/records$`, "u"),
  },
  {
    kind: "get-record", method: "GET",
    path: "/projects/{project_id}/key-value-stores/{store_name}/records/{record_key}",
    operationId: "getKeyValueRecord",
    pattern: new RegExp(`${storesPath}/${storageNamePath}/records/${recordKeyPath}$`, "u"),
  },
  {
    kind: "put-record", method: "PUT",
    path: "/projects/{project_id}/key-value-stores/{store_name}/records/{record_key}",
    operationId: "putKeyValueRecord",
    pattern: new RegExp(`${storesPath}/${storageNamePath}/records/${recordKeyPath}$`, "u"),
  },
  {
    kind: "delete-record", method: "DELETE",
    path: "/projects/{project_id}/key-value-stores/{store_name}/records/{record_key}",
    operationId: "deleteKeyValueRecord",
    pattern: new RegExp(`${storesPath}/${storageNamePath}/records/${recordKeyPath}$`, "u"),
  },
] as const;

export const storageRouterOperations = storageRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

/** Key-value record writes carry raw bytes of any media type instead of a JSON body. */
export const rawBodyRoutePattern = new RegExp(
  `${storesPath}/${storageNamePath}/records/${recordKeyPath}$`, "u",
);

const schedulesPath = `^/v1/projects/${uuidPath}/schedules`;

export const scheduleRouteDefinitions = [
  {
    kind: "create", method: "POST", path: "/projects/{project_id}/schedules",
    operationId: "createJobSchedule", pattern: new RegExp(`${schedulesPath}$`, "u"),
  },
  {
    kind: "list", method: "GET", path: "/projects/{project_id}/schedules",
    operationId: "listJobSchedules", pattern: new RegExp(`${schedulesPath}$`, "u"),
  },
  {
    kind: "get", method: "GET", path: "/projects/{project_id}/schedules/{schedule_id}",
    operationId: "getJobSchedule", pattern: new RegExp(`${schedulesPath}/${uuidPath}$`, "u"),
  },
  {
    kind: "delete", method: "DELETE", path: "/projects/{project_id}/schedules/{schedule_id}",
    operationId: "deleteJobSchedule", pattern: new RegExp(`${schedulesPath}/${uuidPath}$`, "u"),
  },
  {
    kind: "enable", method: "POST", path: "/projects/{project_id}/schedules/{schedule_id}/enable",
    operationId: "enableJobSchedule", pattern: new RegExp(`${schedulesPath}/${uuidPath}/enable$`, "u"),
  },
  {
    kind: "disable", method: "POST", path: "/projects/{project_id}/schedules/{schedule_id}/disable",
    operationId: "disableJobSchedule", pattern: new RegExp(`${schedulesPath}/${uuidPath}/disable$`, "u"),
  },
] as const;

export const scheduleRouterOperations = scheduleRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

export const humanAuthRouteDefinitions = [
  {
    kind: "begin", method: "GET", path: "/auth/oidc/begin",
    operationId: "beginHumanOidcLogin", pattern: /^\/v1\/auth\/oidc\/begin$/u,
  },
  {
    kind: "callback", method: "GET", path: "/auth/oidc/callback",
    operationId: "completeHumanOidcLogin", pattern: /^\/v1\/auth\/oidc\/callback$/u,
  },
  {
    kind: "refresh", method: "POST", path: "/auth/refresh",
    operationId: "refreshHumanSession", pattern: /^\/v1\/auth\/refresh$/u,
  },
  {
    kind: "logout", method: "POST", path: "/auth/logout",
    operationId: "logoutHumanSession", pattern: /^\/v1\/auth\/logout$/u,
  },
] as const;

export const humanAuthRouterOperations = humanAuthRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

export const organizationProjectRouteDefinitions = [
  {
    kind: "organizations",
    pattern: /^\/v1\/organizations$/u,
    methods: ["GET"],
    operations: [{ method: "GET", path: "/organizations", operationId: "listOrganizations" }],
  },
  {
    kind: "projects",
    pattern: new RegExp(`^/v1/organizations/${uuidPath}/projects$`, "u"),
    methods: ["GET", "POST"],
    operations: [
      {
        method: "GET", path: "/organizations/{organization_id}/projects",
        operationId: "listOrganizationProjects",
      },
      {
        method: "POST", path: "/organizations/{organization_id}/projects",
        operationId: "createOrganizationProject",
      },
    ],
  },
] as const;

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

export const projectAdminRouterOperations = Object.freeze([
  ...organizationProjectRouteDefinitions[0].operations,
  ...organizationProjectRouteDefinitions[1].operations,
  ...projectApiKeyRouteDefinitions[0].operations,
  ...projectApiKeyRouteDefinitions[1].operations,
]);

export const workerBootstrapRouteDefinitions = [
  {
    kind: "create-enrollment", method: "POST",
    path: "/projects/{project_id}/worker-enrollments", operationId: "createWorkerEnrollment",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/worker-enrollments$`, "u"),
  },
  {
    kind: "enroll", method: "POST", path: "/worker-enrollments",
    operationId: "enrollWorker", pattern: /^\/v1\/worker-enrollments$/u,
  },
  {
    kind: "challenge", method: "POST", path: "/worker-sessions/challenges",
    operationId: "createWorkerSessionChallenge", pattern: /^\/v1\/worker-sessions\/challenges$/u,
  },
  {
    kind: "session", method: "POST", path: "/worker-sessions",
    operationId: "createWorkerSession", pattern: /^\/v1\/worker-sessions$/u,
  },
  {
    kind: "disable", method: "POST", path: "/projects/{project_id}/workers/{worker_id}/disable",
    operationId: "disableProjectWorker",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/workers/${uuidPath}/disable$`, "u"),
  },
] as const;

export const workerBootstrapRouterOperations = workerBootstrapRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

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
  {
    pattern: new RegExp(`^/v1/job-leases/${uuidPath}/artifact-uploads$`, "u"),
    kind: "artifact-upload",
    method: "POST",
    path: "/job-leases/{lease_id}/artifact-uploads",
    operationId: "requestArtifactUpload",
  },
  {
    pattern: new RegExp(`^/v1/job-leases/${uuidPath}/artifact-uploads/confirm$`, "u"),
    kind: "artifact-confirm",
    method: "POST",
    path: "/job-leases/{lease_id}/artifact-uploads/confirm",
    operationId: "confirmArtifactUpload",
  },
] as const;

export const workerRouterOperations = workerRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

export const controlPlaneRouterOperations = Object.freeze([
  ...humanAuthRouterOperations,
  ...projectAdminRouterOperations,
  ...workerBootstrapRouterOperations,
  ...projectJobRouterOperations,
  ...webhookRouterOperations,
  ...storageRouterOperations,
  ...scheduleRouterOperations,
  ...workerRouterOperations,
]);
