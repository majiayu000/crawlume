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

  it("drops credentials typed into the URL", () => {
    expect(redactUrl("https://alice:s3cret@example.com/a")).toBe("https://example.com/a (credentials removed)");
    expect(redactUrl("https://alice:s3cret@example.com/a?token=abc"))
      .toBe("https://example.com/a (credentials and query removed)");

    const error = new ReadError("INVALID_URL", "Credentials in URLs are not allowed.");
    const report = buildReadReport("https://alice:s3cret@example.com/private", { error }, manifest);
    expect(report.body).toContain("- URL: https://example.com/private (credentials removed)");
    expect(report.body).not.toMatch(/alice|s3cret/u);
    expect(decodeURIComponent(report.issueUrl)).not.toMatch(/alice|s3cret/u);
  });

  it("redacts URLs that the error details repeat", () => {
    const error = new ReadError("ROBOTS_DISALLOWED", "robots.txt disallows this page for the reader.", {
      details: {
        url: "https://example.com/private?token=abc123",
        robotsUrl: "https://example.com/robots.txt",
        location: "https://example.com/next?session=xyz789#frag",
        httpStatus: 404,
      },
    });
    const report = buildReadReport("https://example.com/private?token=abc123", { error }, manifest);

    expect(report.body).toContain('"url": "https://example.com/private (query removed)"');
    expect(report.body).toContain('"robotsUrl": "https://example.com/robots.txt"');
    expect(report.body).toContain('"location": "https://example.com/next (query removed)"');
    expect(report.body).toContain('"httpStatus": 404');
    expect(report.body).not.toMatch(/abc123|xyz789/u);
    expect(decodeURIComponent(report.issueUrl)).not.toMatch(/abc123|xyz789/u);
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

  it("never splits an emoji when it shortens the preview or the issue link", () => {
    const report = (title: string, contentMarkdown: string) => buildReadReport("https://example.com/a", {
      result: {
        fetchMethod: "http",
        completeness: "complete",
        title,
        contentMarkdown,
        evidence: {
          httpStatus: 200, contentType: "text/html", contentCharacters: contentMarkdown.length,
          extractionMethod: "readability", extractorVersion: "e1", validatorVersion: "v1", accessPlan: plan,
        },
      } as never,
    }, manifest);

    // The 400th UTF-16 unit is the first half of an emoji.
    const preview = report("Short", `${"x".repeat(399)}😀 and more text`);
    expect(preview.body).toContain(`${"x".repeat(399)}\n\`\`\``);
    expect(new URL(preview.issueUrl).searchParams.get("body")).toBe(preview.body);
    // Each title length moves where the issue link cuts the body.
    let truncated = 0;
    for (let length = 300; length < 420; length += 1) {
      const long = report("😀".repeat(length), "😀".repeat(200));
      const body = new URL(long.issueUrl).searchParams.get("body") ?? "";
      expect(long.issueUrl.length).toBeLessThanOrEqual(7_500);
      expect(body).not.toContain("�");
      if (body.includes("Report truncated")) truncated += 1;
    }
    expect(truncated).toBeGreaterThan(0);
  });

  it("reads the version and issue tracker from package.json", () => {
    expect(packageManifest()).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/u),
      bugsUrl: "https://github.com/majiayu000/crawlume/issues",
    });
  });
});
