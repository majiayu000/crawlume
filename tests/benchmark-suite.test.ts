import { describe, expect, it } from "vitest";

import { parseBenchmarkModeOptions } from "../benchmarks/harness/suite.js";

describe("unified benchmark modes", () => {
  it("enforces the minimum repeat count for PR and nightly", () => {
    expect(parseBenchmarkModeOptions(["--mode", "pr"])).toEqual({
      mode: "pr",
      repeats: 5,
      comparePath: null,
    });
    expect(parseBenchmarkModeOptions(["--mode", "nightly", "--repeats", "7"])).toEqual({
      mode: "nightly",
      repeats: 7,
      comparePath: null,
    });
    expect(() => parseBenchmarkModeOptions(["--mode", "pr", "--repeats", "4"]))
      .toThrow("at least 5");
    expect(parseBenchmarkModeOptions(["--", "--mode", "pr"])).toEqual({
      mode: "pr",
      repeats: 5,
      comparePath: null,
    });
  });

  it("requires an exact baseline path and 30 repeats for release", () => {
    expect(parseBenchmarkModeOptions([
      "--mode", "release", "--compare", "baseline.json",
    ])).toEqual({
      mode: "release",
      repeats: 30,
      comparePath: "baseline.json",
    });
    expect(() => parseBenchmarkModeOptions(["--mode", "release"]))
      .toThrow("--compare is required");
    expect(() => parseBenchmarkModeOptions([
      "--mode", "release", "--compare", "baseline.json", "--repeats", "5",
    ])).toThrow("at least 30");
    expect(() => parseBenchmarkModeOptions([
      "--mode", "nightly", "--compare", "baseline.json",
    ])).toThrow("only valid for release");
  });

  it("rejects unknown and incomplete arguments visibly", () => {
    expect(() => parseBenchmarkModeOptions([])).toThrow("--mode");
    expect(() => parseBenchmarkModeOptions(["--mode", "fast"])).toThrow("pr, nightly, or release");
    expect(() => parseBenchmarkModeOptions(["--mode", "pr", "--unknown", "x"]))
      .toThrow("unknown benchmark option");
  });
});
