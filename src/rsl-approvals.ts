import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";

import type { RslUsage, RslUserClass } from "./config.js";

const APPROVABLE_FIXED_OBLIGATIONS = new Set(["attribution", "legal"]);

export type RslApprovalContext = {
  licenseHash: string;
  resource: string;
  usage: RslUsage;
  userClass: RslUserClass | null;
  geo: string | null;
  obligations: string[];
};

type RslApproval = RslApprovalContext & {
  expiresAt: string;
  approvedBy: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validObligation(value: string): boolean {
  if (APPROVABLE_FIXED_OBLIGATIONS.has(value)) return true;
  const prefix = value.startsWith("standard:")
    ? "standard:"
    : value.startsWith("terms:")
      ? "terms:"
      : null;
  if (prefix === null) return false;
  try {
    const url = new URL(value.slice(prefix.length));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function optionalString(
  entry: Record<string, unknown>,
  field: "userClass" | "geo",
): string | null {
  const value = entry[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Every RSL approval ${field} must be a string or null.`);
  }
  return value;
}

function parseApproval(value: unknown, now: number): RslApproval {
  if (!isObject(value)) throw new Error("Every RSL approval must be an object.");
  const requiredStrings = [
    "licenseHash",
    "resource",
    "usage",
    "expiresAt",
    "approvedBy",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Every RSL approval ${field} must be a non-empty string.`);
    }
  }
  const licenseHash = value.licenseHash as string;
  const resource = value.resource as string;
  const usage = value.usage as string;
  const expiresAt = value.expiresAt as string;
  const approvedBy = value.approvedBy as string;
  if (!/^sha256:[0-9a-f]{64}$/.test(licenseHash)) {
    throw new Error("Every RSL approval licenseHash must be sha256 followed by lowercase hex.");
  }
  if (!["ai-train", "ai-input", "ai-index", "search"].includes(usage)) {
    throw new Error("Every RSL approval usage must be a supported concrete usage.");
  }
  const userClass = optionalString(value, "userClass");
  if (
    userClass !== null &&
    !["commercial", "non-commercial", "education", "government", "personal"].includes(userClass)
  ) {
    throw new Error("Every RSL approval userClass must be a supported value or null.");
  }
  const geo = optionalString(value, "geo");
  if (geo !== null && !/^[A-Z]{2}$/.test(geo)) {
    throw new Error("Every RSL approval geo must be two uppercase ASCII letters or null.");
  }
  if (!Array.isArray(value.obligations) || value.obligations.some((item) => typeof item !== "string")) {
    throw new Error("Every RSL approval obligations field must be a string array.");
  }
  const obligations = [...new Set(value.obligations as string[])].sort();
  if (obligations.length !== value.obligations.length || obligations.some((item) => !validObligation(item))) {
    throw new Error("RSL approval obligations must be unique supported obligations.");
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || !expiresAt.endsWith("Z") || expiresAtMs <= now) {
    throw new Error("Every RSL approval expiresAt must be a future RFC 3339 UTC timestamp.");
  }
  if (approvedBy.length > 200 || /[\r\n]/.test(approvedBy)) {
    throw new Error("Every RSL approval approvedBy must be a short single-line identity.");
  }
  return {
    licenseHash,
    resource,
    usage: usage as RslUsage,
    userClass: userClass as RslUserClass | null,
    geo,
    obligations,
    expiresAt,
    approvedBy,
  };
}

function approvalKey(approval: RslApprovalContext): string {
  return JSON.stringify({
    licenseHash: approval.licenseHash,
    resource: approval.resource,
    usage: approval.usage,
    userClass: approval.userClass,
    geo: approval.geo,
    obligations: [...approval.obligations].sort(),
  });
}

export class RslApprovalStore {
  private readonly approvals: Map<string, RslApproval>;

  constructor(
    path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!existsSync(path)) {
      this.approvals = new Map();
      return;
    }
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("The RSL approvals path must point to a regular file.");
    if (platform() !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("The RSL approvals file must not be accessible by group or other users.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("The RSL approvals file must contain valid JSON.");
    }
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.approvals)) {
      throw new Error("The RSL approvals file must use version 1 with an approvals array.");
    }
    const approvals = parsed.approvals.map((approval) => parseApproval(approval, this.now()));
    const keys = approvals.map(approvalKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error("The RSL approvals file must not contain duplicate approvals.");
    }
    this.approvals = new Map(approvals.map((approval) => [approvalKey(approval), approval]));
  }

  get contextHash(): string {
    return createHash("sha256")
      .update(
        JSON.stringify(
          [...this.approvals.values()]
            .filter((approval) => Date.parse(approval.expiresAt) > this.now())
            .sort((a, b) => approvalKey(a).localeCompare(approvalKey(b))),
        ),
      )
      .digest("hex");
  }

  has(context: RslApprovalContext): boolean {
    const approval = this.approvals.get(approvalKey(context));
    return approval !== undefined && Date.parse(approval.expiresAt) > this.now();
  }
}
