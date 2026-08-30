import { createHash } from "node:crypto";

import { ReadError } from "./errors.js";
import type { ExtractedPage, RawPage } from "./types.js";

export type AdapterCapability = "extraction" | "readiness";

export type AdapterRoiEvidence = {
  observedDays: number;
  eligibleVolume30d: number;
  genericValidRate: number;
  expectedSavings30d: number;
  maintenanceCost30d: number;
  fixturePassRate: number;
  canaryPassRate: number;
  errorCasePassRate: number;
  pairedReleaseBenchmark: boolean;
  officialStructuredSourceAvailable: boolean;
};

export type AdapterRoiHypothesis = {
  targetGenericValidRate: number;
  minEligibleVolume30d: number;
  minNetSavings30d: number;
};

export type AdapterRoiReason =
  | "generic_path_meets_target"
  | "eligible_volume_below_threshold"
  | "net_savings_below_threshold"
  | "fixture_evidence_incomplete"
  | "canary_evidence_incomplete"
  | "error_case_evidence_incomplete"
  | "paired_release_benchmark_missing"
  | "official_structured_source_available";

export type AdapterRoiEvaluation = {
  schemaVersion: 1;
  evaluationId: string;
  adapterId: string;
  adapterVersion: string;
  evaluatedAt: string;
  hypothesis: AdapterRoiHypothesis;
  evidence: AdapterRoiEvidence;
  evidenceHash: string;
  decision: "eligible" | "ineligible";
  reasons: AdapterRoiReason[];
};

export type SiteAdapterManifest = {
  schemaVersion: 1;
  id: string;
  version: string;
  hosts: string[];
  capabilities: AdapterCapability[];
  outputSchema: {
    id: string;
    version: string;
    validate(artifact: ExtractedPage): string[];
  };
  benchmarkCases: {
    fixtures: string[];
    liveCanaries: string[];
    errors: string[];
  };
  retirement: {
    evaluationWindowDays: number;
    minEligibleVolume: number;
    minNetSavings: number;
    retireWhenOfficialStructuredSourceExists: boolean;
  };
};

export type SiteAdapter = {
  manifest: SiteAdapterManifest;
  extract(page: RawPage): ExtractedPage | null | Promise<ExtractedPage | null>;
};

export type SiteAdapterResult = {
  adapterId: string;
  adapterVersion: string;
  schemaId: string;
  schemaVersion: string;
  artifact: ExtractedPage;
};

function canonicalAdapterEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAdapterEvidence);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalAdapterEvidence(entry)]));
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalAdapterEvidence(value))).digest("hex")}`;
}

function adapterEvidenceId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(value).slice("sha256:".length)}`;
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`);
}

function assertRate(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between zero and one`);
  }
}

function evaluationBody(
  input: Omit<AdapterRoiEvaluation, "evaluationId" | "evidenceHash" | "decision" | "reasons">,
) {
  return {
    schemaVersion: input.schemaVersion,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    evaluatedAt: input.evaluatedAt,
    hypothesis: input.hypothesis,
    evidence: input.evidence,
  };
}

export function evaluateAdapterRoi(input: {
  adapterId: string;
  adapterVersion: string;
  evaluatedAt: string;
  hypothesis: AdapterRoiHypothesis;
  evidence: AdapterRoiEvidence;
}): AdapterRoiEvaluation {
  assertRate(input.hypothesis.targetGenericValidRate, "targetGenericValidRate");
  assertNonNegative(input.hypothesis.minEligibleVolume30d, "minEligibleVolume30d");
  assertNonNegative(input.hypothesis.minNetSavings30d, "minNetSavings30d");
  assertNonNegative(input.evidence.observedDays, "observedDays");
  assertNonNegative(input.evidence.eligibleVolume30d, "eligibleVolume30d");
  assertNonNegative(input.evidence.expectedSavings30d, "expectedSavings30d");
  assertNonNegative(input.evidence.maintenanceCost30d, "maintenanceCost30d");
  for (const field of [
    "genericValidRate", "fixturePassRate", "canaryPassRate", "errorCasePassRate",
  ] as const) assertRate(input.evidence[field], field);
  const reasons: AdapterRoiReason[] = [];
  if (input.evidence.genericValidRate >= input.hypothesis.targetGenericValidRate) {
    reasons.push("generic_path_meets_target");
  }
  if (input.evidence.eligibleVolume30d < input.hypothesis.minEligibleVolume30d) {
    reasons.push("eligible_volume_below_threshold");
  }
  const netSavings = input.evidence.expectedSavings30d - input.evidence.maintenanceCost30d;
  if (netSavings < input.hypothesis.minNetSavings30d) {
    reasons.push("net_savings_below_threshold");
  }
  if (input.evidence.fixturePassRate !== 1) reasons.push("fixture_evidence_incomplete");
  if (input.evidence.canaryPassRate !== 1) reasons.push("canary_evidence_incomplete");
  if (input.evidence.errorCasePassRate !== 1) reasons.push("error_case_evidence_incomplete");
  if (!input.evidence.pairedReleaseBenchmark) reasons.push("paired_release_benchmark_missing");
  if (input.evidence.officialStructuredSourceAvailable) {
    reasons.push("official_structured_source_available");
  }
  const body = evaluationBody({ schemaVersion: 1, ...input });
  return {
    ...body,
    evidenceHash: sha256(input.evidence),
    evaluationId: adapterEvidenceId("adapter_roi", body),
    decision: reasons.length === 0 ? "eligible" : "ineligible",
    reasons,
  };
}

function assertEvaluationIntegrity(evaluation: AdapterRoiEvaluation): void {
  const expected = evaluateAdapterRoi({
    adapterId: evaluation.adapterId,
    adapterVersion: evaluation.adapterVersion,
    evaluatedAt: evaluation.evaluatedAt,
    hypothesis: evaluation.hypothesis,
    evidence: evaluation.evidence,
  });
  if (
    evaluation.evaluationId !== expected.evaluationId ||
    evaluation.evidenceHash !== expected.evidenceHash ||
    evaluation.decision !== expected.decision ||
    JSON.stringify(evaluation.reasons) !== JSON.stringify(expected.reasons)
  ) throw new Error("adapter ROI evaluation integrity check failed");
}

function assertIds(values: string[], field: string): void {
  if (values.length === 0 || values.some((value) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value))) {
    throw new Error(`${field} requires stable case ids`);
  }
}

function assertManifest(manifest: SiteAdapterManifest): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.id)) {
    throw new Error("adapter id must be stable lowercase kebab-case");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(manifest.version)) throw new Error("adapter version must be semver");
  if (manifest.hosts.length === 0 || manifest.hosts.some((host) =>
    host !== host.toLowerCase() || !/^[a-z0-9.-]+$/u.test(host) || host.includes("..")
  )) throw new Error("adapter hosts must be exact lowercase hostnames");
  if (new Set(manifest.hosts).size !== manifest.hosts.length) {
    throw new Error("adapter hosts must be unique");
  }
  if (manifest.capabilities.length === 0) throw new Error("adapter requires a capability");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.outputSchema.id)) {
    throw new Error("adapter output schema id must be stable");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(manifest.outputSchema.version)) {
    throw new Error("adapter output schema version must be semver");
  }
  assertIds(manifest.benchmarkCases.fixtures, "fixture evidence");
  assertIds(manifest.benchmarkCases.liveCanaries, "live canary evidence");
  assertIds(manifest.benchmarkCases.errors, "error case evidence");
  if (!Number.isSafeInteger(manifest.retirement.evaluationWindowDays) ||
      manifest.retirement.evaluationWindowDays < 1) {
    throw new Error("adapter retirement window must be a positive integer");
  }
  assertNonNegative(manifest.retirement.minEligibleVolume, "retirement minEligibleVolume");
  assertNonNegative(manifest.retirement.minNetSavings, "retirement minNetSavings");
}

export function evaluateAdapterRetirement(
  manifest: SiteAdapterManifest,
  evidence: AdapterRoiEvidence,
): { retire: boolean; reasons: string[] } {
  assertManifest(manifest);
  if (
    manifest.retirement.retireWhenOfficialStructuredSourceExists &&
    evidence.officialStructuredSourceAvailable
  ) return { retire: true, reasons: ["official_structured_source_available"] };
  if (evidence.observedDays < manifest.retirement.evaluationWindowDays) {
    return { retire: false, reasons: [] };
  }
  const reasons: string[] = [];
  if (evidence.eligibleVolume30d < manifest.retirement.minEligibleVolume) {
    reasons.push("eligible_volume_below_retirement_threshold");
  }
  if (evidence.expectedSavings30d - evidence.maintenanceCost30d <
      manifest.retirement.minNetSavings) {
    reasons.push("net_savings_below_retirement_threshold");
  }
  return { retire: reasons.length > 0, reasons };
}

export class SiteAdapterRegistry {
  private readonly byHost = new Map<string, SiteAdapter>();
  private readonly adapters = new Map<string, SiteAdapter>();

  register(adapter: SiteAdapter, evaluation: AdapterRoiEvaluation): void {
    assertManifest(adapter.manifest);
    assertEvaluationIntegrity(evaluation);
    if (
      evaluation.decision !== "eligible" ||
      evaluation.adapterId !== adapter.manifest.id ||
      evaluation.adapterVersion !== adapter.manifest.version
    ) throw new Error("adapter registration requires a matching eligible ROI evaluation");
    const key = `${adapter.manifest.id}@${adapter.manifest.version}`;
    if (this.adapters.has(key)) throw new Error(`adapter already registered: ${key}`);
    for (const host of adapter.manifest.hosts) {
      if (this.byHost.has(host)) throw new Error(`adapter host already registered: ${host}`);
    }
    this.adapters.set(key, adapter);
    for (const host of adapter.manifest.hosts) this.byHost.set(host, adapter);
  }

  list(): Array<{ id: string; version: string; hosts: string[] }> {
    return [...this.adapters.values()].map(({ manifest }) => ({
      id: manifest.id,
      version: manifest.version,
      hosts: [...manifest.hosts],
    })).sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(url: string): SiteAdapter | null {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return this.byHost.get(parsed.hostname) ?? null;
  }

  async extract(url: string, page: RawPage): Promise<SiteAdapterResult | null> {
    const adapter = this.resolve(url);
    if (adapter === null) return null;
    const final = new URL(page.finalUrl);
    if (!adapter.manifest.hosts.includes(final.hostname)) {
      throw new ReadError("ACCESS_DENIED", "Adapter final URL is outside its declared hosts.");
    }
    const artifact = await adapter.extract(page);
    if (artifact === null) return null;
    const errors = adapter.manifest.outputSchema.validate(artifact);
    if (errors.length > 0) {
      throw new ReadError("INCOMPLETE_CONTENT", `Adapter output schema failed: ${errors.join("; ")}`, {
        details: {
          adapterId: adapter.manifest.id,
          adapterVersion: adapter.manifest.version,
          schemaId: adapter.manifest.outputSchema.id,
          schemaVersion: adapter.manifest.outputSchema.version,
        },
      });
    }
    return {
      adapterId: adapter.manifest.id,
      adapterVersion: adapter.manifest.version,
      schemaId: adapter.manifest.outputSchema.id,
      schemaVersion: adapter.manifest.outputSchema.version,
      artifact,
    };
  }
}

export const defaultSiteAdapterRegistry = new SiteAdapterRegistry();
