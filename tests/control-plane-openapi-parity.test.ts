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
});
