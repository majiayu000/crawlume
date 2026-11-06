import { describe, expect, it } from "vitest";

import { buildReadReport, redactUrl } from "../src/cli/report.js";
import { packageManifest } from "../src/package-manifest.js";
import { parseCli } from "../src/cli/main.js";
import { ReadError } from "../src/errors.js";

const manifest = { version: "9.9.9", bugsUrl: "https://github.com/example/crawlume/issues" };
const plan = {
  planId: "plan-1",
  plannerVersion: "p1",
  plannedStages: [
    { stageId: "http", provider: "http", reasonCode: "default" },
    { stageId: "browser", provider: "browser", reasonCode: "shell" },
  ],
  executedStages: ["http"],
} as never;

describe("crawlume report", () => {
  it("always reproduces live instead of answering from the cache", () => {
    expect(parseCli(["report", "--cache-mode", "prefer-cache", "https://example.com/a"])).toEqual({
      kind: "report",
      options: { url: "https://example.com/a", cacheMode: "live" },
    });
    expect(() => parseCli(["report", "--markdown", "https://example.com/a"])).toThrow(/only for read/u);
  });

  it("drops query strings and fragments that may carry tokens", () => {
    expect(redactUrl("https://example.com/a?token=secret#x")).toBe("https://example.com/a (query removed)");
    expect(redactUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("describes a failed read with its error code, stages and a prefilled issue link", () => {
    const error = new ReadError("SHELL_ONLY", "The page is an application shell.", {
      details: { visibleCharacters: 12 },
      execution: { ...(plan as object), requestId: "r1" } as never,
    });
    const report = buildReadReport("https://example.com/app?session=abc", { error }, manifest);

    expect(report.title).toBe("read report: example.com (SHELL_ONLY)");
    expect(report.body).toContain("- URL: https://example.com/app (query removed)");
    expect(report.body).toContain("- Result: error SHELL_ONLY");
    expect(report.body).toContain("http/http/default, browser/browser/shell (skipped)");
    expect(report.body).not.toContain("session=abc");
    const link = new URL(report.issueUrl);
    expect(link.origin + link.pathname).toBe("https://github.com/example/crawlume/issues/new");
    expect(link.searchParams.get("title")).toBe(report.title);
    expect(link.searchParams.get("body")).toBe(report.body);
  });

  it("keeps the issue link within GitHub's length limit for long content", () => {
    const result = {
      fetchMethod: "http",
      completeness: "complete",
      title: "Long",
      contentMarkdown: "x".repeat(400),
      evidence: {
        httpStatus: 200, contentType: "text/html", contentCharacters: 400,
        extractionMethod: "readability", extractorVersion: "e1", validatorVersion: "v1", accessPlan: plan,
      },
    } as never;
    const report = buildReadReport(`https://example.com/${"p".repeat(9_000)}`, { result }, manifest);

    expect(report.body).toContain("- Result: ok via http, completeness complete");
    expect(report.issueUrl.length).toBeLessThanOrEqual(7_500);
    expect(new URL(report.issueUrl).searchParams.get("body")).toContain("Report truncated");
  });

  it("reads the version and issue tracker from package.json", () => {
    expect(packageManifest()).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/u),
      bugsUrl: "https://github.com/majiayu000/crawlume/issues",
    });
  });
});
