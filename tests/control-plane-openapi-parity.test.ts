import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  projectApiKeyRouterOperations,
  projectJobRouterOperations,
  workerRouterOperations,
} from "../src/control-plane/router-contract.js";

type OpenApiOperation = Readonly<{
  method: string;
  operationId: string;
  path: string;
  planned: boolean;
  source: string;
}>;

const httpMethod = /^(?:get|post|put|patch|delete|options|head|trace)$/u;

function openApiOperations(source: string, document: string): readonly OpenApiOperation[] {
  expect(document, `${source} must declare OpenAPI 3.2`).toMatch(/^openapi: 3\.2\.\d+$/mu);

  const operations: OpenApiOperation[] = [];
  let path: string | null = null;
  let pending: Omit<OpenApiOperation, "operationId" | "planned"> & {
    operationId: string | null;
    planned: boolean;
  } | null = null;
  let inPaths = false;

  const finishOperation = (): void => {
    if (pending === null) return;
    expect(pending.operationId, `${source} ${pending.method} ${pending.path} needs operationId`)
      .not.toBeNull();
    operations.push({ ...pending, operationId: pending.operationId! });
    pending = null;
  };

  for (const line of document.split("\n")) {
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[^\s#]/u.test(line)) {
      finishOperation();
      break;
    }

    const pathMatch = /^  (\/[^:]+):\s*$/u.exec(line);
    if (pathMatch?.[1] !== undefined) {
      finishOperation();
      path = pathMatch[1];
      continue;
    }
    const methodMatch = /^    ([a-z]+):\s*$/u.exec(line);
    if (path !== null && methodMatch?.[1] !== undefined && httpMethod.test(methodMatch[1])) {
      finishOperation();
      pending = {
        method: methodMatch[1].toUpperCase(),
        operationId: null,
        path,
        planned: false,
        source,
      };
      continue;
    }
    if (pending === null) continue;

    const operationId = /^      operationId:\s*([A-Za-z][A-Za-z0-9]*)\s*$/u.exec(line)?.[1];
    if (operationId !== undefined) {
      expect(pending.operationId, `${source} ${pending.method} ${pending.path} has duplicate operationId`)
        .toBeNull();
      pending.operationId = operationId;
      continue;
    }
    const status = /^      x-status:\s*(\S+)\s*$/u.exec(line)?.[1];
    if (status !== undefined) {
      expect(status, `${source} ${pending.method} ${pending.path} has unsupported x-status`)
        .toBe("Planned");
      pending.planned = true;
    }
  }
  finishOperation();
  return operations;
}

function operationKey(operation: Pick<OpenApiOperation, "method" | "operationId" | "path">): string {
  return `${operation.method} ${operation.path} (${operation.operationId})`;
}

describe("control-plane OpenAPI Router parity", () => {
  it("requires every operationId to be implemented or explicitly Planned", () => {
    const documents = [
      "project-control-api.openapi.yaml",
      "worker-control-api.openapi.yaml",
    ].map((source) => openApiOperations(
      source,
      readFileSync(new URL(`../docs/${source}`, import.meta.url), "utf8"),
    ));
    const documented = documents.flat();
    const implemented = [
      ...projectJobRouterOperations,
      ...projectApiKeyRouterOperations,
      ...workerRouterOperations,
    ];

    const documentedIds = documented.map(({ operationId }) => operationId);
    const implementedKeys = implemented.map(operationKey);
    expect(new Set(documentedIds).size, "OpenAPI operationId values must be globally unique")
      .toBe(documentedIds.length);
    expect(new Set(implementedKeys).size, "Router operation declarations must be unique")
      .toBe(implementedKeys.length);

    const plannedKeys = new Set(documented.filter(({ planned }) => planned).map(operationKey));
    const documentedImplementationKeys = documented
      .filter(({ planned }) => !planned)
      .map(operationKey)
      .sort();
    expect(implementedKeys.filter((key) => plannedKeys.has(key)),
      "an implemented Router operation cannot remain Planned").toEqual([]);
    expect(implementedKeys.sort()).toEqual(documentedImplementationKeys);
  });
});
