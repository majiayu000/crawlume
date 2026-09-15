import { z } from "zod";

import {
  cacheModes,
  searchSources,
  searchTimeRanges,
  type BrowserReadinessPolicy,
} from "../types.js";

export const controlPlaneJobTypes = ["read", "inspect", "map", "crawl", "search"] as const;
export type ControlPlaneJobType = (typeof controlPlaneJobTypes)[number];

export type ControlPlaneReadJobInput = Readonly<{
  url: string;
  browserAllowed?: boolean | undefined;
  cacheMode?: (typeof cacheModes)[number] | undefined;
  maxAgeSeconds?: number | undefined;
  browserReadiness?: BrowserReadinessPolicy | undefined;
}>;

export type ControlPlaneMapJobInput = Readonly<{
  url: string;
  browserAllowed?: boolean | undefined;
  maxPages?: number | undefined;
  maxDepth?: number | undefined;
  includeSubdomains?: boolean | undefined;
  ignoreQueryParameters?: boolean | undefined;
}>;

export type ControlPlaneCrawlJobInput = ControlPlaneReadJobInput & Readonly<{
  maxPages?: number | undefined;
  maxDepth?: number | undefined;
  includeSubdomains?: boolean | undefined;
  ignoreQueryParameters?: boolean | undefined;
  concurrency?: number | undefined;
}>;

export type ControlPlaneSearchJobInput = Readonly<{
  query: string;
  limit?: number | undefined;
  page?: number | undefined;
  language?: string | undefined;
  safeSearch?: 0 | 1 | 2 | undefined;
  timeRange?: (typeof searchTimeRanges)[number] | undefined;
  source?: (typeof searchSources)[number] | undefined;
}>;

export type ControlPlaneJobRequest =
  | Readonly<{ type: "read"; input: ControlPlaneReadJobInput }>
  | Readonly<{ type: "inspect"; input: ControlPlaneReadJobInput }>
  | Readonly<{ type: "map"; input: ControlPlaneMapJobInput }>
  | Readonly<{ type: "crawl"; input: ControlPlaneCrawlJobInput }>
  | Readonly<{ type: "search"; input: ControlPlaneSearchJobInput }>;
export type ControlPlaneJobInput = ControlPlaneJobRequest["input"];
export type ControlPlaneRequiredCapabilities = Readonly<{
  http?: true | undefined;
  browser?: true | undefined;
  pdf?: true | undefined;
  feed?: true | undefined;
}>;

const absoluteHttpUrlPattern = /^https?:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/u;
const absoluteHttpUrl = z.string().refine(
  (value) => {
    if (!absoluteHttpUrlPattern.test(value)) return false;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  "URL must be exact lowercase HTTP or HTTPS without whitespace or user information.",
);

const browserReadiness = z.object({
  target: z.object({
    selector: z.string().min(1).max(512).regex(/\S/u),
    state: z.enum(["attached", "visible"]).optional(),
    minCount: z.number().int().min(1).max(10_000).optional(),
  }).strict(),
  interaction: z.object({
    type: z.literal("scroll-to-end"),
    maxSteps: z.number().int().min(1).max(100),
    stepDelayMs: z.number().int().min(0).max(5_000).optional(),
  }).strict().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
}).strict();

const readJobInputFields = {
  url: absoluteHttpUrl,
  browserAllowed: z.boolean().optional(),
  cacheMode: z.enum(cacheModes).optional(),
  maxAgeSeconds: z.number().int().positive().safe().optional(),
  browserReadiness: browserReadiness.optional(),
};

function allowsBrowserReadiness(input: Readonly<{
  browserAllowed?: boolean | undefined;
  browserReadiness?: unknown;
}>): boolean {
  return input.browserAllowed !== false || input.browserReadiness === undefined;
}

const readJobInput = z.object(readJobInputFields).strict().refine(
  allowsBrowserReadiness,
  "browserReadiness requires browserAllowed to be enabled.",
);

const mapJobInput = z.object({
  url: absoluteHttpUrl,
  browserAllowed: z.boolean().optional(),
  maxPages: z.number().int().positive().max(500).optional(),
  maxDepth: z.number().int().min(0).max(10).optional(),
  includeSubdomains: z.boolean().optional(),
  ignoreQueryParameters: z.boolean().optional(),
}).strict();

const crawlJobInput = z.object({
  ...readJobInputFields,
  maxPages: z.number().int().positive().max(10_000).optional(),
  maxDepth: z.number().int().min(0).max(10).optional(),
  includeSubdomains: z.boolean().optional(),
  ignoreQueryParameters: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(32).optional(),
}).strict().refine(
  allowsBrowserReadiness,
  "browserReadiness requires browserAllowed to be enabled.",
);

const searchJobInput = z.object({
  query: z.string().min(1).max(512).regex(/\S/u),
  limit: z.number().int().positive().max(20).optional(),
  page: z.number().int().positive().max(100).optional(),
  language: z.string().regex(/^(?:all|[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)$/u).optional(),
  safeSearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  timeRange: z.enum(searchTimeRanges).optional(),
  source: z.enum(searchSources).optional(),
}).strict();

const requiredCapabilities = z.object({
  http: z.literal(true).optional(),
  browser: z.literal(true).optional(),
  pdf: z.literal(true).optional(),
  feed: z.literal(true).optional(),
}).strict();

export function parseControlPlaneJobCreation(
  type: string,
  input: unknown,
  capabilities: unknown,
): ControlPlaneJobRequest & Readonly<{
  requiredCapabilities: ControlPlaneRequiredCapabilities;
}> {
  const parsedCapabilities = requiredCapabilities.safeParse(capabilities);
  if (!parsedCapabilities.success) {
    throw new TypeError("input.requiredCapabilities is invalid.");
  }
  const finish = <Request extends ControlPlaneJobRequest>(request: Request) => ({
    ...request,
    requiredCapabilities: parsedCapabilities.data,
  });
  switch (type) {
    case "read": {
      const parsed = readJobInput.safeParse(input);
      if (parsed.success) return finish({ type, input: parsed.data });
      break;
    }
    case "inspect": {
      const parsed = readJobInput.safeParse(input);
      if (parsed.success) return finish({ type, input: parsed.data });
      break;
    }
    case "map": {
      const parsed = mapJobInput.safeParse(input);
      if (parsed.success) return finish({ type, input: parsed.data });
      break;
    }
    case "crawl": {
      const parsed = crawlJobInput.safeParse(input);
      if (parsed.success) return finish({ type, input: parsed.data });
      break;
    }
    case "search": {
      const parsed = searchJobInput.safeParse(input);
      if (parsed.success) return finish({ type, input: parsed.data });
      break;
    }
    default:
      throw new TypeError("input.type is not a supported Job type.");
  }
  throw new TypeError("input.input is invalid for the selected Job type.");
}
