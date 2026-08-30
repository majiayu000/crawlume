import { JSDOM } from "jsdom";

import { ReadError, type ReadErrorCode } from "./errors.js";
import type {
  ExtractedPage,
  RawPage,
  ReadIntent,
  ValidationResult,
} from "./types.js";

export type ValidationCandidate = {
  intent: ReadIntent;
  page: RawPage;
  candidate: ExtractedPage;
};

export type CandidateValidator = {
  id: string;
  version: string;
  supports(input: ValidationCandidate): boolean;
  validate(input: ValidationCandidate): ValidationResult;
};

const outcomeRank: Record<ValidationResult["outcome"], number> = {
  valid: 0,
  uncertain: 1,
  invalid: 2,
};

export class ValidatorRegistry {
  constructor(private readonly validators: readonly CandidateValidator[]) {}

  validate(input: ValidationCandidate): ValidationResult {
    const results = this.validators
      .filter((validator) => validator.supports(input))
      .map((validator) => validator.validate(input));
    if (results.length === 0) {
      throw new ReadError("UNSUPPORTED_CONTENT_TYPE", "No validator supports the candidate artifact.", {
        details: { contentType: input.page.contentType },
      });
    }
    if (results.length === 1) return results[0] as ValidationResult;
    const outcome = results.reduce<ValidationResult["outcome"]>(
      (current, result) => outcomeRank[result.outcome] > outcomeRank[current]
        ? result.outcome
        : current,
      "valid",
    );
    return {
      outcome,
      validatorVersion: results.map((result) => result.validatorVersion).join("+"),
      checks: results.flatMap((result) => result.checks),
      terminalError: results.find((result) => result.terminalError !== null)?.terminalError ?? null,
    };
  }
}

type FailedCheck = {
  code: string;
  message: string;
  errorCode: ReadErrorCode;
};

function genericContentValidation(input: ValidationCandidate): ValidationResult {
  const { candidate, intent, page } = input;
  const mediaType = page.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const html = mediaType === "" || mediaType === "text/html" || mediaType === "application/xhtml+xml";
  const document = html ? new JSDOM(page.body, { url: page.finalUrl }).window.document : null;
  const title = document?.title.trim() ?? candidate.title;
  const bodyText = (document?.body?.textContent ?? candidate.markdown).replace(/\s+/gu, " ").trim();
  const combined = `${title}\n${bodyText}`.toLowerCase();
  const failed: FailedCheck[] = [];
  const checks: ValidationResult["checks"] = [];
  const required = (
    code: string,
    passed: boolean,
    message: string,
    errorCode: ReadErrorCode,
  ): void => {
    checks.push({ code, passed, message });
    if (!passed) failed.push({ code, message, errorCode });
  };

  const challenge = [
    "are you a robot",
    "verify you are human",
    "checking your browser",
    "attention required! | cloudflare",
    "security verification",
    "captcha",
    "unusual traffic",
  ].some((signal) => combined.includes(signal));
  required(
    "HUMAN_VERIFICATION_REQUIRED",
    !challenge,
    "The candidate must not be a human-verification or bot-challenge page.",
    "HUMAN_VERIFICATION_REQUIRED",
  );

  const login = document?.querySelector("form input[type='password' i]") !== null && document !== null ||
    /\b(log in|sign in)\b.*\b(sign up|join)\b/iu.test(combined) ||
    /^(log in|sign in)$/iu.test(title);
  required(
    "LOGIN_WALL_DETECTED",
    !login,
    "The candidate must not be a login wall.",
    "LOGIN_WALL_DETECTED",
  );

  const paywallNode = document?.querySelector(
    "[class*='paywall' i], [id*='paywall' i], [data-testid*='paywall' i], [class*='metered' i]",
  );
  const paywall = paywallNode !== null && paywallNode !== undefined &&
    /subscribe to (continue|read)|subscription required|you have reached your (article|story) limit|members only/iu.test(bodyText);
  required(
    "PAYMENT_REQUIRED",
    !paywall,
    "The candidate must not be a subscription wall.",
    "PAYMENT_REQUIRED",
  );

  const shell = html && (
    /enable javascript|javascript is disabled|loading(?:\.{3}|…)|something went wrong/iu.test(bodyText) ||
    (bodyText.length < 240 && (document?.querySelectorAll("script").length ?? 0) > 3)
  ) && candidate.markdown.length < 2_000;
  required(
    "SHELL_ONLY",
    !shell,
    "The candidate must contain rendered content instead of an application shell.",
    "SHELL_ONLY",
  );

  const errorTemplate = candidate.contentCharacters < 500 &&
    /^(?:404|not found|page not found|page unavailable|internal server error)\b/iu.test(title);
  required(
    "ERROR_TEMPLATE",
    !errorTemplate,
    "The candidate must not be an error template returned as page content.",
    "INCOMPLETE_CONTENT",
  );

  const discovery = intent.completion.type === "discovery";
  const structured = new Set([
    "json", "json-ld", "rss", "atom", "sitemap", "pdf",
  ]).has(candidate.extractionMethod);
  required(
    "CONTENT_MINIMUM",
    discovery || (structured
      ? candidate.contentCharacters > 0 || candidate.links.length > 0
      : candidate.contentCharacters >= 240),
    "The candidate must contain enough readable content for the requested operation.",
    "INCOMPLETE_CONTENT",
  );

  checks.push({
    code: "PREFERRED_CONTENT_LENGTH",
    passed: structured || candidate.contentCharacters >= 500,
    message: "The candidate should contain at least 500 readable characters.",
  });
  checks.push({
    code: "PRIMARY_EXTRACTION",
    passed: candidate.extractionMethod !== "document",
    message: "The candidate should not depend on generic document fallback extraction.",
  });
  const canonical = document?.querySelector<HTMLLinkElement>("link[rel~='canonical' i]")?.href;
  checks.push({
    code: "CANONICAL_IDENTITY",
    passed: canonical === undefined
      ? null
      : new URL(canonical, page.finalUrl).origin === new URL(intent.url).origin,
    message: "A declared canonical URL should preserve the requested origin identity.",
  });
  if (intent.output.schemaId === undefined) {
    checks.push({
      code: "REQUESTED_SCHEMA",
      passed: null,
      message: "No output schema was requested.",
    });
  } else {
    required(
      "REQUESTED_SCHEMA",
      false,
      "A requested output schema requires a matching schema validator.",
      "INCOMPLETE_CONTENT",
    );
  }

  const terminal = failed[0];
  if (terminal !== undefined) {
    return {
      outcome: "invalid",
      validatorVersion: "generic-content-v1",
      checks,
      terminalError: { code: terminal.errorCode, message: terminal.message },
    };
  }
  const uncertain = checks.some((check) => check.passed === false);
  return {
    outcome: uncertain ? "uncertain" : "valid",
    validatorVersion: "generic-content-v1",
    checks,
    terminalError: null,
  };
}

export const genericContentValidator: CandidateValidator = {
  id: "generic-content",
  version: "generic-content-v1",
  supports: () => true,
  validate: genericContentValidation,
};

export const defaultValidatorRegistry = new ValidatorRegistry([genericContentValidator]);
