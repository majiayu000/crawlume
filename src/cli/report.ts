import type { ReadError } from "../errors.js";
import type { PackageManifest as Manifest } from "../package-manifest.js";
import type { ReadPageResult } from "../types.js";

// GitHub rejects issue links much longer than this; the full report still prints to stdout.
const maxIssueUrlLength = 7_500;
const previewCharacters = 400;

/** Drops the query and fragment, which often carry tokens or session identifiers. */
export function redactUrl(url: string): string {
  // An unparseable URL is reported as typed; the reader has already rejected it.
  const parsed = URL.parse(url);
  if (parsed === null) return url;
  const redacted = parsed.search !== "" || parsed.hash !== "";
  parsed.search = "";
  parsed.hash = "";
  return redacted ? `${parsed.toString()} (query removed)` : parsed.toString();
}

export type ReportOutcome = { result: ReadPageResult } | { error: ReadError };

export type ReadReport = { title: string; body: string; issueUrl: string };

function stages(plan: { plannedStages: Array<{ stageId: string; provider: string; reasonCode: string }>; executedStages: string[] } | null): string {
  if (plan === null) return "(none)";
  const executed = new Set(plan.executedStages);
  return plan.plannedStages
    .map((stage) => `${stage.stageId}/${stage.provider}/${stage.reasonCode}${executed.has(stage.stageId) ? "" : " (skipped)"}`)
    .join(", ");
}

export function buildReadReport(url: string, outcome: ReportOutcome, manifest: Manifest): ReadReport {
  const target = redactUrl(url);
  const lines = [
    `- URL: ${target}`,
    `- crawlume: ${manifest.version}`,
    `- Node.js: ${process.version} on ${process.platform}-${process.arch}`,
  ];
  let summary: string;
  if ("error" in outcome) {
    const error = outcome.error;
    summary = error.code;
    lines.push(
      `- Result: error ${error.code}${error.retryable ? " (retryable)" : ""}`,
      `- Message: ${error.message}`,
      `- Stages: ${stages(error.execution)}`,
      "",
      "Error details:",
      "```json",
      JSON.stringify(error.details, null, 2),
      "```",
    );
  } else {
    const { result } = outcome;
    summary = `ok via ${result.fetchMethod}`;
    lines.push(
      `- Result: ok via ${result.fetchMethod}, completeness ${result.completeness}`,
      `- HTTP: ${result.evidence.httpStatus} ${result.evidence.contentType}`,
      `- Content: ${result.evidence.contentCharacters} characters, extractor ${result.evidence.extractionMethod} ${result.evidence.extractorVersion}, validator ${result.evidence.validatorVersion}`,
      `- Stages: ${stages(result.evidence.accessPlan)}`,
      `- Title: ${result.title}`,
      "",
      `First ${previewCharacters} characters of the extracted Markdown:`,
      "```markdown",
      result.contentMarkdown.slice(0, previewCharacters),
      "```",
    );
  }
  const title = `read report: ${URL.parse(url)?.hostname ?? target} (${summary})`;
  const body = [
    "### What did you expect?",
    "",
    "<!-- For example: the article text, or an error instead of a login page. -->",
    "",
    "### Report",
    "",
    ...lines,
    "",
  ].join("\n");
  return { title, body, issueUrl: issueUrl(manifest.bugsUrl, title, body) };
}

function issueUrl(bugsUrl: string, title: string, body: string): string {
  const base = `${bugsUrl.replace(/\/$/u, "")}/new?labels=read-report&title=${encodeURIComponent(title)}&body=`;
  const full = base + encodeURIComponent(body);
  if (full.length <= maxIssueUrlLength) return full;
  const note = "\n\n(Report truncated; paste the full report printed by `crawlume report`.)";
  let cut = body.length;
  let candidate = full;
  while (candidate.length > maxIssueUrlLength && cut > 0) {
    cut = Math.floor(cut * 0.9);
    candidate = base + encodeURIComponent(body.slice(0, cut) + note);
  }
  return candidate;
}
