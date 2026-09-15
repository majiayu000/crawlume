import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { ControlPlaneHttpApi } from "../src/control-plane/project-http-api.js";

type OpenApiOperation = Readonly<{
  method: string;
  operationId: string;
  path: string;
  planned: boolean;
}>;

const httpMethods = [
  "get", "post", "put", "patch", "delete", "options", "head", "trace",
] as const;
const openApiSchema = z.object({
  openapi: z.string().regex(/^3\.2\.\d+$/u),
  paths: z.record(z.string().startsWith("/"), z.unknown()),
}).passthrough();
const pathItemSchema = z.record(z.string(), z.unknown());
const operationSchema = z.object({
  operationId: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/u),
  "x-status": z.literal("Planned").optional(),
}).passthrough();
const operationResponsesSchema = operationSchema.extend({
  responses: z.record(z.string(), z.unknown()),
});
const responseReferenceSchema = z.object({ $ref: z.string() }).strict();
const schemaCatalogSchema = z.object({
  components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
}).passthrough();
const objectPropertiesSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
}).passthrough();
const oneOfSchema = z.object({ oneOf: z.array(z.unknown()) }).passthrough();
const safeIntegerSchema = z.object({
  type: z.literal("integer"),
  maximum: z.literal(Number.MAX_SAFE_INTEGER),
}).passthrough();
const objectSchema = z.record(z.string(), z.unknown());
const securitySchema = z.array(z.record(z.string(), z.array(z.unknown())));

function parseDocument(source: string, document: string): unknown {
  try {
    return parse(document);
  } catch (error) {
    throw new Error(`${source} is not valid YAML`, { cause: error });
  }
}

function parseValue<T>(source: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${source} is not valid OpenAPI: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function openApiOperations(source: string, document: string): readonly OpenApiOperation[] {
  const openApi = parseValue(source, openApiSchema, parseDocument(source, document));
  const operations: OpenApiOperation[] = [];
  for (const [path, rawPathItem] of Object.entries(openApi.paths)) {
    const pathItem = parseValue(`${source} path ${path}`, pathItemSchema, rawPathItem);
    for (const method of httpMethods) {
      if (pathItem[method] === undefined) continue;
      const operation = parseValue(
        `${source} ${method.toUpperCase()} ${path}`,
        operationSchema,
        pathItem[method],
      );
      operations.push({
        method: method.toUpperCase(),
        operationId: operation.operationId,
        path,
        planned: operation["x-status"] === "Planned",
      });
    }
  }
  return operations;
}

function loadOpenApi(source: string): Record<string, unknown> {
  return parseValue(
    source,
    objectSchema,
    parseDocument(source, readFileSync(new URL(`../docs/${source}`, import.meta.url), "utf8")),
  );
}

function objectValue(source: string, value: unknown): Record<string, unknown> {
  return parseValue(source, objectSchema, value);
}

function operationValue(
  source: string,
  document: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> {
  const paths = objectValue(`${source} paths`, document.paths);
  const pathItem = objectValue(`${source} path ${path}`, paths[path]);
  return objectValue(`${source} ${method} ${path}`, pathItem[method.toLowerCase()]);
}

function resolvedResponse(
  source: string,
  document: Record<string, unknown>,
  response: unknown,
): Record<string, unknown> {
  const value = objectValue(`${source} response`, response);
  if (typeof value.$ref !== "string") return value;
  const prefix = "#/components/responses/";
  if (!value.$ref.startsWith(prefix)) throw new Error(`${source} response reference is not local`);
  const components = objectValue(`${source} components`, document.components);
  const responses = objectValue(`${source} component responses`, components.responses);
  return objectValue(`${source} ${value.$ref}`, responses[value.$ref.slice(prefix.length)]);
}

function operationKey(operation: Pick<OpenApiOperation, "method" | "operationId" | "path">): string {
  return `${operation.method} ${operation.path} (${operation.operationId})`;
}

function routeKey(operation: Pick<OpenApiOperation, "method" | "path">): string {
  return `${operation.method} ${operation.path}`;
}

describe("control-plane OpenAPI Router parity", () => {
  it("fails visibly when an OpenAPI document is malformed YAML", () => {
    expect(() => openApiOperations(
      "malformed.openapi.yaml",
      "openapi: 3.2.0\npaths:\n  /broken: [\n",
    )).toThrow("malformed.openapi.yaml is not valid YAML");
  });

  it("bounds decoded Worker control responses for Remote Worker clients", () => {
    const document = loadOpenApi("worker-control-api.openapi.yaml");
    expect(document["x-max-response-body-bytes"]).toBe(256 * 1_024);
  });

  it("requires every operationId to be integrated or explicitly Planned", () => {
    const documented = [
      "project-control-api.openapi.yaml",
      "worker-control-api.openapi.yaml",
    ].flatMap((source) => openApiOperations(
      source,
      readFileSync(new URL(`../docs/${source}`, import.meta.url), "utf8"),
    ));
    const integrated = ControlPlaneHttpApi.routerOperations;

    const documentedIds = documented.map(({ operationId }) => operationId);
    const documentedRoutes = documented.map(routeKey);
    const integratedIds = integrated.map(({ operationId }) => operationId);
    const integratedRoutes = integrated.map(routeKey);
    const integratedKeys = integrated.map(operationKey);
    expect(integrated).toHaveLength(27);
    expect(new Set(documentedIds).size, "OpenAPI operationId values must be globally unique")
      .toBe(documentedIds.length);
    expect(new Set(documentedRoutes).size, "OpenAPI method and path pairs must be globally unique")
      .toBe(documentedRoutes.length);
    expect(new Set(integratedIds).size, "integrated Router operationId values must be unique")
      .toBe(integratedIds.length);
    expect(new Set(integratedRoutes).size, "integrated Router method and path pairs must be unique")
      .toBe(integratedRoutes.length);

    const plannedKeys = new Set(documented.filter(({ planned }) => planned).map(operationKey));
    const documentedIntegratedKeys = documented
      .filter(({ planned }) => !planned)
      .map(operationKey)
      .sort();
    expect(integratedKeys.filter((key) => plannedKeys.has(key)),
      "an integrated Router operation cannot remain Planned").toEqual([]);
    expect(integratedKeys.sort()).toEqual(documentedIntegratedKeys);
  });

  it("keeps all integrated bootstrap contracts aligned with exact security and responses", () => {
    const projectSource = "project-control-api.openapi.yaml";
    const workerSource = "worker-control-api.openapi.yaml";
    const documents = {
      [projectSource]: loadOpenApi(projectSource),
      [workerSource]: loadOpenApi(workerSource),
    };
    const human = [{ HumanAccessToken: [] }];
    const contracts = [
      {
        source: projectSource, method: "GET", path: "/auth/oidc/begin",
        operationId: "beginHumanOidcLogin", security: [], statuses: ["302", "400", "429", "500"],
        successStatus: "302", successMediaType: null,
      },
      {
        source: projectSource, method: "GET", path: "/auth/oidc/callback",
        operationId: "completeHumanOidcLogin", security: [],
        statuses: ["200", "400", "401", "500"], successStatus: "200",
        successMediaType: "application/json",
      },
      {
        source: projectSource, method: "POST", path: "/auth/refresh",
        operationId: "refreshHumanSession", security: [{ HumanRefreshCookie: [] }],
        statuses: ["200", "400", "401", "409", "500"], successStatus: "200",
        successMediaType: "application/json",
      },
      {
        source: projectSource, method: "POST", path: "/auth/logout",
        operationId: "logoutHumanSession", security: human,
        statuses: ["204", "400", "401", "500"], successStatus: "204", successMediaType: null,
      },
      {
        source: projectSource, method: "GET", path: "/organizations",
        operationId: "listOrganizations", security: human,
        statuses: ["200", "400", "401", "500"], successStatus: "200",
        successMediaType: "application/json",
      },
      {
        source: projectSource, method: "GET", path: "/organizations/{organization_id}/projects",
        operationId: "listOrganizationProjects", security: human,
        statuses: ["200", "400", "401", "404", "500"], successStatus: "200",
        successMediaType: "application/json",
      },
      {
        source: projectSource, method: "POST", path: "/organizations/{organization_id}/projects",
        operationId: "createOrganizationProject", security: human,
        statuses: ["201", "400", "401", "403", "404", "409", "413", "415", "422", "500"],
        successStatus: "201", successMediaType: "application/json",
      },
      {
        source: projectSource, method: "POST", path: "/projects/{project_id}/api-keys",
        operationId: "createProjectApiKey", security: human,
        statuses: ["201", "400", "401", "403", "413", "415", "422", "500"],
        successStatus: "201", successMediaType: "application/json",
      },
      {
        source: projectSource, method: "GET", path: "/projects/{project_id}/api-keys",
        operationId: "listProjectApiKeys", security: human,
        statuses: ["200", "400", "401", "403", "500"], successStatus: "200",
        successMediaType: "application/json",
      },
      {
        source: projectSource, method: "DELETE", path: "/projects/{project_id}/api-keys/{key_id}",
        operationId: "revokeProjectApiKey", security: human,
        statuses: ["204", "400", "401", "403", "404", "500"], successStatus: "204",
        successMediaType: null,
      },
      {
        source: workerSource, method: "POST", path: "/projects/{project_id}/worker-enrollments",
        operationId: "createWorkerEnrollment", security: human,
        statuses: ["201", "400", "401", "403", "413", "415", "422", "500"],
        successStatus: "201", successMediaType: "application/json",
      },
      {
        source: workerSource, method: "POST", path: "/worker-enrollments",
        operationId: "enrollWorker", security: [{ WorkerEnrollmentToken: [] }],
        statuses: ["201", "400", "401", "413", "415", "422", "500"],
        successStatus: "201", successMediaType: "application/json",
      },
      {
        source: workerSource, method: "POST", path: "/worker-sessions/challenges",
        operationId: "createWorkerSessionChallenge", security: [],
        statuses: ["201", "400", "413", "415", "422", "429", "500"],
        successStatus: "201", successMediaType: "application/json",
      },
      {
        source: workerSource, method: "POST", path: "/worker-sessions",
        operationId: "createWorkerSession", security: [],
        statuses: ["201", "400", "413", "415", "422", "500"],
        successStatus: "201", successMediaType: "application/json",
      },
      {
        source: workerSource, method: "POST",
        path: "/projects/{project_id}/workers/{worker_id}/disable",
        operationId: "disableProjectWorker", security: human,
        statuses: ["200", "400", "401", "403", "404", "413", "415", "422", "500"],
        successStatus: "200", successMediaType: "application/json",
      },
    ] as const;

    for (const contract of contracts) {
      const document = documents[contract.source];
      const operation = operationValue(contract.source, document, contract.path, contract.method);
      expect(operation.operationId).toBe(contract.operationId);
      expect(operation["x-status"]).toBeUndefined();
      expect(parseValue(`${contract.operationId} security`, securitySchema, operation.security))
        .toEqual(contract.security);
      const responses = objectValue(`${contract.operationId} responses`, operation.responses);
      expect(Object.keys(responses).sort()).toEqual([...contract.statuses].sort());
      const success = resolvedResponse(contract.source, document, responses[contract.successStatus]);
      if (contract.successMediaType === null) {
        expect(success.content).toBeUndefined();
      } else {
        const content = objectValue(`${contract.operationId} success content`, success.content);
        expect(content).toHaveProperty(contract.successMediaType);
      }
      for (const status of contract.statuses.filter((value) => Number(value) >= 400)) {
        const error = resolvedResponse(contract.source, document, responses[status]);
        const content = objectValue(`${contract.operationId} ${status} content`, error.content);
        expect(content).toHaveProperty("application/problem+json");
      }
    }
    expect(contracts).toHaveLength(15);
    const documentedPlanned = [projectSource, workerSource]
      .flatMap((source) => openApiOperations(
        source,
        readFileSync(new URL(`../docs/${source}`, import.meta.url), "utf8"),
      ))
      .filter(({ planned }) => planned)
      .map(operationKey)
      .sort();
    expect(documentedPlanned).toEqual([]);
  });

  it("documents bootstrap browser bindings, one-time credentials, and idempotency boundaries", () => {
    const projectSource = "project-control-api.openapi.yaml";
    const workerSource = "worker-control-api.openapi.yaml";
    const project = loadOpenApi(projectSource);
    const worker = loadOpenApi(workerSource);

    const callback = operationValue(projectSource, project, "/auth/oidc/callback", "GET");
    const callbackParameters = parseValue(
      "OIDC callback parameters",
      z.array(objectSchema),
      callback.parameters,
    );
    expect(callbackParameters.map(({ name, in: location, required }) => ({ name, location, required })))
      .toEqual([
        { name: "state", location: "query", required: true },
        { name: "code", location: "query", required: false },
        { name: "error", location: "query", required: false },
        { name: "error_description", location: "query", required: false },
        { name: "error_uri", location: "query", required: false },
        { name: "__Secure-diaoyan_oidc_state", location: "cookie", required: true },
      ]);
    const projectComponents = objectValue("project components", project.components);
    const projectSecurity = objectValue("project security schemes", projectComponents.securitySchemes);
    expect(objectValue("refresh cookie scheme", projectSecurity.HumanRefreshCookie)).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "__Secure-diaoyan_refresh",
      description: expect.stringContaining("/v1/auth/refresh"),
    });

    const createProject = operationValue(
      projectSource,
      project,
      "/organizations/{organization_id}/projects",
      "POST",
    );
    const projectParameters = parseValue(
      "Project creation parameters",
      z.array(objectSchema),
      createProject.parameters,
    );
    const idempotency = projectParameters.find(({ name }) => name === "Idempotency-Key");
    expect(idempotency).toMatchObject({ in: "header", required: true });
    expect(objectValue("Idempotency-Key schema", idempotency?.schema)).toMatchObject({
      minLength: 1,
      maxLength: 200,
    });
    const projectRequestBody = objectValue("Project creation body", createProject.requestBody);
    const projectRequestContent = objectValue(
      "Project creation content",
      projectRequestBody.content,
    );
    const projectRequestMedia = objectValue(
      "Project creation JSON",
      projectRequestContent["application/json"],
    );
    const projectRequestSchema = objectValue("Project creation schema", projectRequestMedia.schema);
    const projectRequestProperties = objectValue(
      "Project creation properties",
      projectRequestSchema.properties,
    );
    expect(objectValue("Project slug", projectRequestProperties.slug)).not.toHaveProperty("maxLength");
    expect(objectValue("Project name", projectRequestProperties.name)).not.toHaveProperty("maxLength");

    const createApiKey = operationValue(
      projectSource,
      project,
      "/projects/{project_id}/api-keys",
      "POST",
    );
    expect(createApiKey.description).toContain("non-idempotent");
    const apiKeyParameters = parseValue(
      "API Key creation parameters",
      z.array(objectSchema),
      createApiKey.parameters,
    );
    expect(apiKeyParameters.some(({ name }) => name === "Idempotency-Key")).toBe(false);
    const apiKeyResponses = objectValue("API Key creation responses", createApiKey.responses);
    const apiKeyCreated = resolvedResponse(projectSource, project, apiKeyResponses["201"]);
    const apiKeyContent = objectValue("API Key creation content", apiKeyCreated.content);
    const apiKeyMedia = objectValue("API Key JSON response", apiKeyContent["application/json"]);
    const apiKeyResponseSchema = objectValue("API Key response schema", apiKeyMedia.schema);
    const apiKeyProperties = objectValue("API Key response properties", apiKeyResponseSchema.properties);
    expect(objectValue("API Key one-time secret", apiKeyProperties.secret)).toMatchObject({
      readOnly: true,
      "x-sensitive": true,
    });
    expect(objectValue("API Key one-time secret", apiKeyProperties.secret)).not.toHaveProperty("example");
    expect(objectValue("API Key 201 headers", apiKeyCreated.headers)).toHaveProperty("Cache-Control");
    const listApiKeys = operationValue(
      projectSource,
      project,
      "/projects/{project_id}/api-keys",
      "GET",
    );
    const listApiKeyParameters = parseValue(
      "API Key list parameters",
      z.array(objectSchema),
      listApiKeys.parameters,
    );
    expect(listApiKeyParameters).toContainEqual({ $ref: "#/components/parameters/OpaqueCursor" });

    const createEnrollment = operationValue(
      workerSource,
      worker,
      "/projects/{project_id}/worker-enrollments",
      "POST",
    );
    expect(createEnrollment.description).toContain("non-idempotent");
    expect(createEnrollment.parameters).toBeDefined();
    const workerComponents = objectValue("worker components", worker.components);
    const workerSchemas = objectValue("worker schemas", workerComponents.schemas);
    const enrollmentResponse = objectValue(
      "Worker enrollment response",
      workerSchemas.CreateWorkerEnrollmentResponse,
    );
    const enrollmentProperties = objectValue(
      "Worker enrollment response properties",
      enrollmentResponse.properties,
    );
    expect(objectValue("one-time enrollment token", enrollmentProperties.enrollment_token))
      .toMatchObject({ readOnly: true, "x-sensitive": true });
    expect(objectValue("one-time enrollment token", enrollmentProperties.enrollment_token))
      .not.toHaveProperty("example");
    const consumeEnrollment = operationValue(
      workerSource,
      worker,
      "/worker-enrollments",
      "POST",
    );
    expect(consumeEnrollment.description).toContain("Consumes the one-time enrollment credential");
    expect(consumeEnrollment.description).toContain("non-idempotent");
    expect(consumeEnrollment.description).toContain("must not be retried automatically");
    const consumeEnrollmentParameters = consumeEnrollment.parameters === undefined
      ? []
      : parseValue("Worker enrollment consumption parameters", z.array(objectSchema), consumeEnrollment.parameters);
    expect(consumeEnrollmentParameters.some(({ name }) => name === "Idempotency-Key")).toBe(false);

    for (const [document, source, path] of [
      [project, projectSource, "/auth/oidc/begin"],
      [worker, workerSource, "/worker-sessions/challenges"],
    ] as const) {
      const operation = operationValue(source, document, path, path.includes("begin") ? "GET" : "POST");
      const responses = objectValue(`${path} responses`, operation.responses);
      const limited = resolvedResponse(source, document, responses["429"]);
      const headers = objectValue(`${path} 429 headers`, limited.headers);
      expect(headers).toHaveProperty("Retry-After");
      expect(headers).toHaveProperty("Cache-Control");
    }
  });

  it("documents transport-level failures for every Project Job action", () => {
    const source = "project-control-api.openapi.yaml";
    const openApi = parseValue(
      source,
      openApiSchema,
      parseDocument(source, readFileSync(new URL(`../docs/${source}`, import.meta.url), "utf8")),
    );
    for (const action of ["pause", "resume", "cancel"] as const) {
      const path = `/projects/{project_id}/jobs/{job_id}/${action}`;
      const pathItem = parseValue(`${source} path ${path}`, pathItemSchema, openApi.paths[path]);
      const operation = parseValue(
        `${source} POST ${path}`,
        operationResponsesSchema,
        pathItem.post,
      );
      expect(parseValue(
        `${source} POST ${path} 400`,
        responseReferenceSchema,
        operation.responses["400"],
      )).toEqual({ $ref: "#/components/responses/MalformedRequest" });
      expect(parseValue(
        `${source} POST ${path} 413`,
        responseReferenceSchema,
        operation.responses["413"],
      )).toEqual({ $ref: "#/components/responses/PayloadTooLarge" });
    }
  });

  it("caps every Worker request integer at the JavaScript safe maximum", () => {
    const source = "worker-control-api.openapi.yaml";
    const openApi = parseValue(
      source,
      schemaCatalogSchema,
      parseDocument(source, readFileSync(new URL(`../docs/${source}`, import.meta.url), "utf8")),
    );
    const requestFields = {
      LeaseGenerationRequest: ["generation"],
      JobEventRequest: ["generation", "local_sequence", "byte_count", "duration_ms"],
      JobPublicationRequest: ["generation", "local_sequence", "byte_count"],
    } as const;
    for (const [schemaName, fieldNames] of Object.entries(requestFields)) {
      const schema = parseValue(
        `${source} schema ${schemaName}`,
        objectPropertiesSchema,
        openApi.components.schemas[schemaName],
      );
      for (const fieldName of fieldNames) {
        expect(parseValue(
          `${source} schema ${schemaName}.${fieldName}`,
          safeIntegerSchema,
          schema.properties[fieldName],
        ).maximum).toBe(Number.MAX_SAFE_INTEGER);
      }
    }

    const complete = parseValue(
      `${source} schema CompleteJobRequest`,
      oneOfSchema,
      openApi.components.schemas.CompleteJobRequest,
    );
    expect(complete.oneOf).toHaveLength(2);
    for (const [index, branch] of complete.oneOf.entries()) {
      const properties = parseValue(
        `${source} schema CompleteJobRequest branch ${index}`,
        objectPropertiesSchema,
        branch,
      ).properties;
      expect(parseValue(
        `${source} schema CompleteJobRequest branch ${index}.generation`,
        safeIntegerSchema,
        properties.generation,
      ).maximum).toBe(Number.MAX_SAFE_INTEGER);
    }
  });
});
