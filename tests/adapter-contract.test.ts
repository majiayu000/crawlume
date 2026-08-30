import { describe, expect, it } from "vitest";

import {
  SiteAdapterRegistry,
  defaultSiteAdapterRegistry,
  evaluateAdapterRetirement,
  evaluateAdapterRoi,
  type SiteAdapter,
} from "../src/adapters.js";
import { ExtractorRegistry } from "../src/extract.js";
import type { RawPage } from "../src/types.js";

const raw: RawPage = {
  body: "<html><body>fixture</body></html>",
  fetchedAt: "2026-08-30T00:00:00.000Z",
  method: "http",
  httpStatus: 200,
  contentType: "text/html",
  responseBytes: 33,
  finalUrl: "https://adapter.example/article",
};

function adapter(): SiteAdapter {
  return {
    manifest: {
      schemaVersion: 1,
      id: "example-article",
      version: "1.0.0",
      hosts: ["adapter.example"],
      capabilities: ["extraction"],
      outputSchema: {
        id: "example-article-output",
        version: "1.0.0",
        validate: (artifact) => artifact.title === "Expected" ? [] : ["title must equal Expected"],
      },
      benchmarkCases: {
        fixtures: ["example-fixture"],
        liveCanaries: ["example-canary"],
        errors: ["example-error"],
      },
      retirement: {
        evaluationWindowDays: 30,
        minEligibleVolume: 100,
        minNetSavings: 1_000,
        retireWhenOfficialStructuredSourceExists: true,
      },
    },
    extract: () => ({
      title: "Expected",
      byline: null,
      publishedTime: null,
      markdown: "adapter fixture content",
      contentCharacters: 23,
      contentHash: "fixture-hash",
      extractionMethod: "document",
      links: [],
    }),
  };
}

const hypothesis = {
  targetGenericValidRate: 0.95,
  minEligibleVolume30d: 100,
  minNetSavings30d: 1_000,
};

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    observedDays: 30,
    eligibleVolume30d: 1_000,
    genericValidRate: 0.8,
    expectedSavings30d: 5_000,
    maintenanceCost30d: 1_000,
    fixturePassRate: 1,
    canaryPassRate: 1,
    errorCasePassRate: 1,
    pairedReleaseBenchmark: true,
    officialStructuredSourceAvailable: false,
    ...overrides,
  };
}

describe("trusted site adapter contract", () => {
  it("keeps the default registry empty while no adapter has passed ROI", () => {
    expect(defaultSiteAdapterRegistry.list()).toEqual([]);
    expect(defaultSiteAdapterRegistry.resolve("https://adapter.example/article")).toBeNull();
  });

  it("registers only an adapter with matching eligible ROI evidence", async () => {
    const value = adapter();
    const registry = new SiteAdapterRegistry();
    const evaluation = evaluateAdapterRoi({
      adapterId: value.manifest.id,
      adapterVersion: value.manifest.version,
      evaluatedAt: "2026-08-30T00:00:00.000Z",
      hypothesis,
      evidence: evidence(),
    });

    expect(evaluation.decision).toBe("eligible");
    expect(evaluation.evaluationId).toMatch(/^adapter_roi_[a-f0-9]{64}$/u);
    registry.register(value, evaluation);
    expect(registry.list()).toEqual([{ id: "example-article", version: "1.0.0",
      hosts: ["adapter.example"] }]);
    expect(registry.resolve("https://adapter.example/article")).toBe(value);
    expect(registry.resolve("https://sub.adapter.example/article")).toBeNull();
    await expect(registry.extract("https://adapter.example/article", raw)).resolves.toMatchObject({
      adapterId: "example-article",
      adapterVersion: "1.0.0",
      schemaId: "example-article-output",
      schemaVersion: "1.0.0",
      artifact: { title: "Expected" },
    });
    await expect(new ExtractorRegistry([], registry).extract(raw)).resolves.toMatchObject({
      candidates: [{
        extractorId: "adapter:example-article",
        extractorVersion: "adapter:example-article@1.0.0",
        artifact: { title: "Expected" },
      }],
      attempts: [{
        extractorId: "adapter:example-article",
        extractorVersion: "adapter:example-article@1.0.0",
        outcome: "candidate",
        errorCode: null,
      }],
    });
  });

  it("fails visibly when adapter output violates its versioned schema", async () => {
    const value = adapter();
    value.extract = () => ({
      title: "Wrong",
      byline: null,
      publishedTime: null,
      markdown: "invalid",
      contentCharacters: 7,
      contentHash: "invalid-hash",
      extractionMethod: "document",
      links: [],
    });
    const registry = new SiteAdapterRegistry();
    registry.register(value, evaluateAdapterRoi({
      adapterId: value.manifest.id,
      adapterVersion: value.manifest.version,
      evaluatedAt: "2026-08-30T00:00:00.000Z",
      hypothesis,
      evidence: evidence(),
    }));

    await expect(registry.extract("https://adapter.example/article", raw))
      .rejects.toThrow("title must equal Expected");
  });

  it("blocks ROI when release evidence or economic value is missing", () => {
    const missingRelease = evaluateAdapterRoi({
      adapterId: "example-article",
      adapterVersion: "1.0.0",
      evaluatedAt: "2026-08-30T00:00:00.000Z",
      hypothesis,
      evidence: evidence({ pairedReleaseBenchmark: false }),
    });
    expect(missingRelease).toMatchObject({ decision: "ineligible" });
    expect(missingRelease.reasons).toContain("paired_release_benchmark_missing");

    const negativeRoi = evaluateAdapterRoi({
      adapterId: "example-article",
      adapterVersion: "1.0.0",
      evaluatedAt: "2026-08-30T00:00:00.000Z",
      hypothesis,
      evidence: evidence({ expectedSavings30d: 500, maintenanceCost30d: 1_000 }),
    });
    expect(negativeRoi.reasons).toContain("net_savings_below_threshold");
    expect(() => new SiteAdapterRegistry().register(adapter(), missingRelease))
      .toThrow("eligible ROI evaluation");
  });

  it("rejects a tampered ROI decision even when the evidence hash still matches", () => {
    const ineligible = evaluateAdapterRoi({
      adapterId: "example-article",
      adapterVersion: "1.0.0",
      evaluatedAt: "2026-08-30T00:00:00.000Z",
      hypothesis,
      evidence: evidence({ pairedReleaseBenchmark: false }),
    });

    expect(() => new SiteAdapterRegistry().register(adapter(), {
      ...ineligible,
      decision: "eligible",
      reasons: [],
    })).toThrow("adapter ROI evaluation integrity check failed");
  });

  it("retires on an official source or sustained low ROI, but not on a partial window", () => {
    const manifest = adapter().manifest;
    expect(evaluateAdapterRetirement(manifest, evidence({
      officialStructuredSourceAvailable: true,
    }))).toEqual({ retire: true, reasons: ["official_structured_source_available"] });
    expect(evaluateAdapterRetirement(manifest, evidence({
      eligibleVolume30d: 10,
      expectedSavings30d: 0,
      observedDays: 30,
    }))).toEqual({
      retire: true,
      reasons: ["eligible_volume_below_retirement_threshold", "net_savings_below_retirement_threshold"],
    });
    expect(evaluateAdapterRetirement(manifest, evidence({
      eligibleVolume30d: 10,
      expectedSavings30d: 0,
      observedDays: 10,
    }))).toEqual({ retire: false, reasons: [] });
  });
});
