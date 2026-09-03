import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PublicReadResultArtifactError,
  encodePublicReadResultArtifact,
} from "../src/remote-worker/read-result-artifact.js";
import type { ReadPageResult } from "../src/types.js";

function readResult(): ReadPageResult {
  return {
    status: "ok",
    sourceUrl: "https://example.com/source",
    finalUrl: "https://example.com/final",
    fetchedAt: "2026-09-03T00:00:00.000Z",
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "Example",
    byline: null,
    publishedTime: null,
    contentMarkdown: "Hello, world.",
    contentHash: "a".repeat(64),
    completeness: "complete",
    validation: {
      outcome: "valid",
      validatorVersion: "generic-content-v1",
      checks: [{ code: "CONTENT", passed: true, message: "Content is present." }],
      terminalError: null,
    },
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 512,
      contentCharacters: 13,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      cacheStatus: "live",
      requestId: "11111111-1111-4111-8111-111111111111",
      accessPlan: {
        planId: `plan_${"b".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{
          stageId: "http-read",
          provider: "http",
          reasonCode: "HTTP_PRIMARY",
        }],
        executedStages: ["http-read"],
      },
    },
  };
}

const goldenJson = `{"result":{"authProfile":null,"byline":null,"completeness":"complete","contentHash":"${"a".repeat(64)}","contentMarkdown":"Hello, world.","evidence":{"accessPlan":{"executedStages":["http-read"],"planId":"plan_${"b".repeat(64)}","plannedStages":[{"provider":"http","reasonCode":"HTTP_PRIMARY","stageId":"http-read"}],"plannerVersion":"access-planner-v1"},"contentCharacters":13,"contentType":"text/html","extractionMethod":"readability","extractorVersion":"readability-v1","httpStatus":200,"requestId":"11111111-1111-4111-8111-111111111111","responseBytes":512,"validatorVersion":"generic-content-v1"},"fetchMethod":"http","fetchedAt":"2026-09-03T00:00:00.000Z","finalUrl":"https://example.com/final","publishedTime":null,"sourceUrl":"https://example.com/source","status":"ok","title":"Example","validation":{"checks":[{"code":"CONTENT","message":"Content is present.","passed":true}],"outcome":"valid","terminalError":null,"validatorVersion":"generic-content-v1"}},"schema":"diaoyan.public-read-result","version":1}`;

describe("encodePublicReadResultArtifact", () => {
  it("emits the exact versioned compact artifact bytes", () => {
    const artifact = encodePublicReadResultArtifact(readResult());

    expect(Buffer.from(artifact.bytes).toString("utf8")).toBe(goldenJson);
    expect(artifact.byteCount).toBe(Buffer.byteLength(goldenJson, "utf8"));
  });

  it("sorts nested keys by Unicode code point while preserving array order", () => {
    const input = readResult() as ReadPageResult & Record<string, unknown>;
    input["😀"] = { "𐀀": 1, "": 2, z: 3, a: 4 };
    input.extraArray = [{ z: 1, a: 2 }, "second", "first"];

    const json = Buffer.from(encodePublicReadResultArtifact(input).bytes).toString("utf8");

    expect(json).toContain('"extraArray":[{"a":2,"z":1},"second","first"]');
    expect(json).toContain('"😀":{"a":4,"z":3,"":2,"𐀀":1}');
  });

  it("omits undefined object fields", () => {
    const input = readResult() as ReadPageResult & Record<string, unknown>;
    input.optional = undefined;
    input.nested = { present: true, missing: undefined };

    const json = Buffer.from(encodePublicReadResultArtifact(input).bytes).toString("utf8");

    expect(json).not.toContain("optional");
    expect(json).toContain('"nested":{"present":true}');
  });

  it("removes cache provenance so live and replayed reads have identical bytes and hashes", () => {
    const live = readResult();
    const replayed = {
      ...readResult(),
      cached: true,
      evidence: { ...readResult().evidence, cacheStatus: "replayed" as const },
    };

    const liveArtifact = encodePublicReadResultArtifact(live);
    const replayedArtifact = encodePublicReadResultArtifact(replayed);

    expect(replayedArtifact.bytes).toEqual(liveArtifact.bytes);
    expect(replayedArtifact.contentHash).toBe(liveArtifact.contentHash);
    expect(Buffer.from(liveArtifact.bytes).toString("utf8")).not.toContain("cached");
    expect(Buffer.from(liveArtifact.bytes).toString("utf8")).not.toContain("cacheStatus");
  });

  it("maps uncertain Reader completeness to partial publication completeness", () => {
    expect(encodePublicReadResultArtifact({
      ...readResult(),
      completeness: "uncertain",
    }).completeness).toBe("partial");
  });

  it("counts UTF-8 bytes instead of JavaScript string code units", () => {
    const artifact = encodePublicReadResultArtifact({
      ...readResult(),
      title: "研究 😀",
      contentMarkdown: "你好",
    });
    const json = Buffer.from(artifact.bytes).toString("utf8");

    expect(artifact.byteCount).toBe(Buffer.byteLength(json, "utf8"));
    expect(artifact.byteCount).toBeGreaterThan(json.length);
  });

  it("does not mutate the Reader result", () => {
    const input = readResult();
    const before = structuredClone(input);

    encodePublicReadResultArtifact(input);

    expect(input).toEqual(before);
    expect(input.cached).toBe(false);
    expect(input.evidence.cacheStatus).toBe("live");
  });

  it.each([
    ["undefined array entry", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = ["SECRET_SENTINEL", undefined];
    }],
    ["sparse array entry", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = Array(1);
    }],
    ["NaN", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = Number.NaN;
    }],
    ["positive infinity", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = Number.POSITIVE_INFINITY;
    }],
    ["negative infinity", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = Number.NEGATIVE_INFINITY;
    }],
    ["bigint", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = 1n;
    }],
    ["function", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = function SECRET_SENTINEL() {};
    }],
    ["symbol", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = Symbol("SECRET_SENTINEL");
    }],
    ["non-plain object", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = new Date("2026-09-03T00:00:00.000Z");
    }],
    ["cycle", (input: ReadPageResult & Record<string, unknown>) => {
      input.invalid = input;
    }],
  ])("rejects %s with one fixed content-free error", (_name, mutate) => {
    const input = readResult() as ReadPageResult & Record<string, unknown>;
    mutate(input);

    let thrown: unknown;
    try {
      encodePublicReadResultArtifact(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PublicReadResultArtifactError);
    expect(thrown).toMatchObject({
      name: "PublicReadResultArtifactError",
      message: "The public read result cannot be encoded as an artifact.",
    });
    expect(String(thrown)).not.toContain("SECRET_SENTINEL");
  });

  it("returns publication metadata whose hash matches the bytes", () => {
    const artifact = encodePublicReadResultArtifact(readResult());

    expect(Object.isFrozen(artifact)).toBe(true);
    expect(artifact).toMatchObject({
      contentHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      byteCount: artifact.bytes.byteLength,
      mediaType: "application/vnd.diaoyan.public-read-result+json;version=1",
      completeness: "complete",
      storage: "worker_local",
    });
    expect(artifact.contentHash).toBe(
      createHash("sha256").update(artifact.bytes).digest("base64url"),
    );
    expect(artifact.contentHash).not.toBe(readResult().contentHash);
  });

  it("returns fresh bytes that do not affect later encodes when mutated", () => {
    const first = encodePublicReadResultArtifact(readResult());
    first.bytes[0] = 0;

    const second = encodePublicReadResultArtifact(readResult());

    expect(first.bytes).not.toEqual(second.bytes);
    expect(Buffer.from(second.bytes).toString("utf8")).toBe(goldenJson);
  });
});
