import { DatabaseSync } from "node:sqlite";

import type { RslUsage } from "./config.js";
import { ReadError } from "./errors.js";
import type {
  ReadPageResult,
  RslAccessAuditEntry,
  RslAccessAuditResult,
  RslPaymentAudit,
} from "./types.js";

type AuditRow = {
  id: number;
  occurred_at: string;
  request_url: string | null;
  final_url: string | null;
  outcome: "success" | "failure";
  error_code: string;
  fetch_method: string;
  cached: number;
  rsl_status: string;
  rsl_usage: RslUsage;
  license_urls_json: string;
  license_hashes_json: string;
  approvals_applied: number;
  license_tokens_applied: number;
  payment_quote_json: string;
};

function safeUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function stringDetail(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    throw new ReadError("INTERNAL_ERROR", "An RSL audit record is malformed.");
  }
}

function paymentAudit(error: ReadError): RslPaymentAudit | null {
  if (error.code !== "RSL_PAYMENT_REQUIRED") return null;
  const protocols = stringDetail(error.details.paymentProtocols)
    ?.split(",")
    .filter((value) => value.length > 0) ?? [];
  const authority = stringDetail(error.details.pricingAuthority);
  return {
    paymentType: stringDetail(error.details.paymentType),
    paymentAmount: stringDetail(error.details.paymentAmount),
    paymentCurrency: stringDetail(error.details.paymentCurrency),
    paymentProtocols: protocols,
    pricingAuthority:
      authority === "declared" || authority === "runtime" ? authority : "unspecified",
    budgetStatus: "disabled",
    settlementStatus: "not-attempted",
  };
}

function safePaymentAudit(value: string): RslPaymentAudit | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ReadError("INTERNAL_ERROR", "An RSL payment audit record is malformed.");
  }
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReadError("INTERNAL_ERROR", "An RSL payment audit record is malformed.");
  }
  const record = parsed as Record<string, unknown>;
  const nullableStrings = [record.paymentType, record.paymentAmount, record.paymentCurrency];
  if (
    nullableStrings.some((item) => item !== null && typeof item !== "string") ||
    !Array.isArray(record.paymentProtocols) ||
    record.paymentProtocols.length > 16 ||
    record.paymentProtocols.some(
      (item) => typeof item !== "string" || item.length === 0 || item.length > 200,
    ) ||
    !["declared", "runtime", "unspecified"].includes(String(record.pricingAuthority)) ||
    record.budgetStatus !== "disabled" ||
    record.settlementStatus !== "not-attempted"
  ) {
    throw new ReadError("INTERNAL_ERROR", "An RSL payment audit record is malformed.");
  }
  return record as RslPaymentAudit;
}

export class RslAccessAudit {
  private readonly database: DatabaseSync;

  constructor(
    path: string,
    private readonly usage: RslUsage,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS rsl_access_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        request_url TEXT,
        final_url TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
        error_code TEXT NOT NULL,
        fetch_method TEXT NOT NULL,
        cached INTEGER NOT NULL CHECK(cached IN (0, 1)),
        rsl_status TEXT NOT NULL,
        rsl_usage TEXT NOT NULL,
        license_urls_json TEXT NOT NULL,
        license_hashes_json TEXT NOT NULL,
        approvals_applied INTEGER NOT NULL CHECK(approvals_applied >= 0),
        license_tokens_applied INTEGER NOT NULL DEFAULT 0 CHECK(license_tokens_applied >= 0),
        payment_quote_json TEXT NOT NULL DEFAULT 'null'
      ) STRICT;
    `);
    const columns = this.database.prepare("PRAGMA table_info(rsl_access_audit)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "license_tokens_applied")) {
      this.database.exec(
        "ALTER TABLE rsl_access_audit ADD COLUMN license_tokens_applied INTEGER NOT NULL DEFAULT 0 CHECK(license_tokens_applied >= 0)",
      );
    }
    if (!columns.some((column) => column.name === "payment_quote_json")) {
      this.database.exec(
        "ALTER TABLE rsl_access_audit ADD COLUMN payment_quote_json TEXT NOT NULL DEFAULT 'null'",
      );
    }
  }

  recordSuccess(result: ReadPageResult): void {
    const rsl = result.evidence.rsl;
    this.insert({
      requestUrl: safeUrl(result.sourceUrl),
      finalUrl: safeUrl(result.finalUrl),
      outcome: "success",
      errorCode: "",
      fetchMethod: result.fetchMethod,
      cached: result.cached,
      rslStatus: rsl?.status ?? "",
      licenseUrls: (rsl?.licenseUrls ?? []).map((url) => safeUrl(url)).filter((url) => url !== null),
      licenseHashes: rsl?.licenseHashes ?? [],
      approvalsApplied: rsl?.approvalsApplied ?? 0,
      licenseTokensApplied: rsl?.licenseTokensApplied ?? 0,
      payment: null,
    });
  }

  recordFailure(requestUrl: string, error: ReadError): void {
    const licenseUrl = safeUrl(stringDetail(error.details.licenseUrl));
    const licenseHash = stringDetail(error.details.licenseHash);
    this.insert({
      requestUrl: safeUrl(requestUrl),
      finalUrl: safeUrl(stringDetail(error.details.url)),
      outcome: "failure",
      errorCode: error.code,
      fetchMethod: "",
      cached: false,
      rslStatus: error.code.startsWith("RSL_") ? "blocked" : "",
      licenseUrls: licenseUrl === null ? [] : [licenseUrl],
      licenseHashes: licenseHash === null ? [] : [licenseHash],
      approvalsApplied: 0,
      licenseTokensApplied: 0,
      payment: paymentAudit(error),
    });
  }

  list(limit = 100): RslAccessAuditResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new ReadError("INVALID_ARGUMENT", "limit must be an integer between 1 and 1000.", {
        details: { limit },
      });
    }
    const rows = this.database
      .prepare(
        `SELECT id, occurred_at, request_url, final_url, outcome, error_code, fetch_method,
                cached, rsl_status, rsl_usage, license_urls_json, license_hashes_json,
                approvals_applied, license_tokens_applied, payment_quote_json
         FROM rsl_access_audit
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as AuditRow[];
    return {
      status: "ok",
      generatedAt: new Date(this.now()).toISOString(),
      entries: rows.map((row): RslAccessAuditEntry => ({
        id: row.id,
        occurredAt: row.occurred_at,
        requestUrl: row.request_url,
        finalUrl: row.final_url,
        outcome: row.outcome,
        errorCode: row.error_code === "" ? null : row.error_code,
        fetchMethod:
          row.fetch_method === "http" || row.fetch_method === "browser" ? row.fetch_method : null,
        cached: row.cached === 1,
        rslStatus:
          row.rsl_status === "not-declared" ||
          row.rsl_status === "not-applicable" ||
          row.rsl_status === "permitted" ||
          row.rsl_status === "blocked"
            ? row.rsl_status
            : null,
        rslUsage: row.rsl_usage,
        licenseUrls: safeJsonArray(row.license_urls_json),
        licenseHashes: safeJsonArray(row.license_hashes_json),
        approvalsApplied: row.approvals_applied,
        licenseTokensApplied: row.license_tokens_applied,
        payment: safePaymentAudit(row.payment_quote_json),
      })),
    };
  }

  close(): void {
    this.database.close();
  }

  private insert(values: {
    requestUrl: string | null;
    finalUrl: string | null;
    outcome: "success" | "failure";
    errorCode: string;
    fetchMethod: string;
    cached: boolean;
    rslStatus: string;
    licenseUrls: string[];
    licenseHashes: string[];
    approvalsApplied: number;
    licenseTokensApplied: number;
    payment: RslPaymentAudit | null;
  }): void {
    try {
      this.database
        .prepare(
          `INSERT INTO rsl_access_audit(
             occurred_at, request_url, final_url, outcome, error_code, fetch_method, cached,
             rsl_status, rsl_usage, license_urls_json, license_hashes_json, approvals_applied,
             license_tokens_applied, payment_quote_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          new Date(this.now()).toISOString(),
          values.requestUrl,
          values.finalUrl,
          values.outcome,
          values.errorCode,
          values.fetchMethod,
          values.cached ? 1 : 0,
          values.rslStatus,
          this.usage,
          JSON.stringify(values.licenseUrls),
          JSON.stringify(values.licenseHashes),
          values.approvalsApplied,
          values.licenseTokensApplied,
          JSON.stringify(values.payment),
        );
    } catch (error) {
      if (error instanceof ReadError) throw error;
      throw new ReadError("INTERNAL_ERROR", "The RSL access audit could not be recorded.", {
        cause: error,
      });
    }
  }
}
