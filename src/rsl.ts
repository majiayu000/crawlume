import { createHash } from "node:crypto";

import { JSDOM } from "jsdom";

import type { AppConfig } from "./config.js";
import { ReadError } from "./errors.js";
import type { TransportResponse } from "./fetch/http.js";
import type { RslDiscoveryMethod, RslEvidence } from "./types.js";
import type { HttpTransport } from "./fetch/http.js";
import { RslApprovalStore } from "./rsl-approvals.js";
import { normalizeRslServer } from "./rsl-client-credentials.js";
import { RslOlpClient } from "./rsl-olp.js";
import { mediaContainerLicenseXml } from "./rsl-file.js";
import {
  evaluateRslPayment,
  rslUrlObligation,
  type RslPaymentQuote,
} from "./rsl-payment.js";

const RSL_NAMESPACE = "https://rslstandard.org/rsl";
const RSL_MEDIA_TYPE = "application/rsl+xml";
const RSL_MAX_BYTES = 1_000_000;
const KNOWN_RSL_ELEMENTS = new Set([
  "rsl",
  "content",
  "license",
  "permits",
  "prohibits",
  "payment",
  "standard",
  "custom",
  "amount",
  "accepts",
  "reporting",
  "legal",
  "schema",
  "alternate",
  "copyright",
  "terms",
]);

type Association = {
  method: RslDiscoveryMethod;
  licenseUrl: string | null;
  inlineXml: string | null;
  htmlScope: boolean;
};

type ParsedRsl = {
  contents: Element[];
  maxAgeDays: number;
};

type CachedRsl = {
  expiresAt: number;
  parsed: ParsedRsl;
};

type Outcome = "permitted" | "prohibited" | "license" | "payment" | "confirmation";

type LicenseEvaluation = {
  outcome: Outcome;
  obligations: string[];
  server: string | null;
  paymentQuote: RslPaymentQuote | null;
};

export type RslAccessDecision = {
  evidence: RslEvidence;
  authorization: string | null;
};

function directChildren(element: Element, localName?: string): Element[] {
  return Array.from(element.children).filter(
    (child) =>
      child.namespaceURI === RSL_NAMESPACE &&
      (localName === undefined || child.localName === localName),
  );
}

function parseRsl(xml: string): ParsedRsl {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new ReadError("RSL_INVALID", "RSL documents must not contain DTD or entity declarations.");
  }
  let document: Document;
  try {
    document = new JSDOM(xml, { contentType: "application/xml" }).window.document;
  } catch {
    throw new ReadError("RSL_INVALID", "The declared RSL document is not valid XML.");
  }
  const root = document.documentElement;
  if (root.localName !== "rsl" || root.namespaceURI !== RSL_NAMESPACE) {
    throw new ReadError("RSL_INVALID", "The declared license is not an RSL 1.0 document.");
  }
  for (const element of Array.from(document.getElementsByTagNameNS(RSL_NAMESPACE, "*"))) {
    if (!KNOWN_RSL_ELEMENTS.has(element.localName)) {
      throw new ReadError("RSL_INVALID", "The RSL document contains an unknown core element.", {
        details: { element: element.localName },
      });
    }
  }
  const contents = directChildren(root, "content");
  for (const content of contents) {
    if (!content.hasAttribute("url") || directChildren(content, "license").length === 0) {
      throw new ReadError("RSL_INVALID", "Each RSL content entry must have a url and a license.");
    }
  }
  const maxAgeRaw = root.getAttribute("max-age");
  const maxAgeDays = maxAgeRaw === null ? 30 : Number(maxAgeRaw);
  if (
    !Number.isSafeInteger(maxAgeDays) ||
    maxAgeDays <= 0 ||
    !Number.isSafeInteger(maxAgeDays * 86_400_000)
  ) {
    throw new ReadError("RSL_INVALID", "RSL max-age must be a positive integer number of days.");
  }
  return { contents, maxAgeDays };
}

function splitTokens(element: Element): string[] {
  return (element.textContent ?? "").trim().split(/\s+/).filter(Boolean);
}

function usageMatches(token: string, usage: string): boolean {
  if (token === "all" || token === usage) {
    return true;
  }
  return token === "ai-all" && usage.startsWith("ai-");
}

function constraintOutcome(
  license: Element,
  type: "usage" | "user" | "geo",
  current: string | null,
  matches: (token: string, current: string) => boolean = (token, value) => token === value,
): Outcome | null {
  const permits = directChildren(license, "permits").find(
    (element) => (element.getAttribute("type") ?? "usage") === type,
  );
  const prohibits = directChildren(license, "prohibits").find(
    (element) => (element.getAttribute("type") ?? "usage") === type,
  );
  if (permits === undefined && prohibits === undefined) {
    return null;
  }
  if (current === null) {
    return "confirmation";
  }
  if (prohibits !== undefined && splitTokens(prohibits).some((token) => matches(token, current))) {
    return "prohibited";
  }
  if (permits !== undefined && !splitTokens(permits).some((token) => matches(token, current))) {
    return "prohibited";
  }
  return null;
}

function evaluateLicense(content: Element, license: Element, config: AppConfig): LicenseEvaluation {
  let server: string | null = null;
  const declaredServer = content.getAttribute("server");
  if (declaredServer !== null) {
    try {
      server = normalizeRslServer(declaredServer);
    } catch {
      throw new ReadError("RSL_INVALID", "The RSL License Server must be a valid HTTPS URL.");
    }
  }
  const usageConstraint = constraintOutcome(license, "usage", config.rslUsage, usageMatches);
  const userConstraint = constraintOutcome(license, "user", config.rslUserClass);
  const geoConstraint = constraintOutcome(license, "geo", config.rslGeo);
  const constraints = [usageConstraint, userConstraint, geoConstraint];
  if (constraints.includes("prohibited")) {
    return { outcome: "prohibited", obligations: [], server, paymentQuote: null };
  }
  const obligations: string[] = [];
  const payment = evaluateRslPayment(license);
  if (payment.outcome === "payment") {
    return {
      outcome: "payment",
      obligations: [],
      server,
      paymentQuote: payment.quote,
    };
  }
  obligations.push(...payment.obligations);
  if (userConstraint === "confirmation") obligations.push("missing-user-context");
  if (geoConstraint === "confirmation") obligations.push("missing-geo-context");
  for (const _reporting of directChildren(license, "reporting")) obligations.push("reporting");
  if (directChildren(license, "legal").length > 0) obligations.push("legal");
  for (const terms of directChildren(content, "terms")) {
    obligations.push(rslUrlObligation("terms", terms.textContent ?? ""));
  }
  const normalizedObligations = [...new Set(obligations)].sort();
  if (
    constraints.includes("confirmation") ||
    normalizedObligations.length > 0
  ) {
    return {
      outcome: "confirmation",
      obligations: normalizedObligations,
      server,
      paymentQuote: null,
    };
  }
  return { outcome: "permitted", obligations: [], server, paymentQuote: null };
}

function licenseHash(license: Element): string {
  return `sha256:${createHash("sha256").update(license.outerHTML).digest("hex")}`;
}

function scopePattern(content: Element, target: URL): { matches: boolean; specificity: number } {
  const scope = content.getAttribute("url") ?? "";
  if (scope.length === 0) {
    return { matches: false, specificity: -1 };
  }
  if (/^https?:\/\//i.test(scope)) {
    let parsed: URL;
    try {
      parsed = new URL(scope);
    } catch {
      throw new ReadError("RSL_INVALID", "An RSL content scope contains an invalid absolute URL.");
    }
    parsed.hash = "";
    const normalizedTarget = new URL(target);
    normalizedTarget.hash = "";
    return {
      matches: parsed.toString() === normalizedTarget.toString(),
      specificity: scope.length,
    };
  }
  if (!scope.startsWith("/")) {
    throw new ReadError("RSL_INVALID", "An RSL content scope must be a path or absolute URL.");
  }
  const endAnchored = scope.endsWith("$");
  const body = endAnchored ? scope.slice(0, -1) : scope;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const expression = new RegExp(`^${escaped}${endAnchored ? "$" : ""}`);
  return {
    matches: expression.test(`${target.pathname}${target.search}`),
    specificity: body.replace(/\*/g, "").length,
  };
}

function applicableContents(parsed: ParsedRsl, target: URL, htmlScope: boolean): Element[] {
  if (htmlScope && parsed.contents.length === 1) {
    return parsed.contents;
  }
  const matches = parsed.contents
    .map((content) => {
      if (htmlScope && content.getAttribute("url") === "") {
        return { content, matches: true, specificity: Number.MAX_SAFE_INTEGER };
      }
      return { content, ...scopePattern(content, target) };
    })
    .filter((entry) => entry.matches);
  const mostSpecific = Math.max(-1, ...matches.map((entry) => entry.specificity));
  return matches.filter((entry) => entry.specificity === mostSpecific).map((entry) => entry.content);
}

function splitLinkHeader(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  let angled = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (!quoted && character === "<") angled = true;
    if (!quoted && character === ">") angled = false;
    if (!quoted && !angled && character === ",") {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

export function rslLinksFromHeader(value: string | null): string[] {
  if (value === null) return [];
  const urls: string[] = [];
  for (const entry of splitLinkHeader(value)) {
    const target = /^\s*<([^>]+)>/.exec(entry)?.[1];
    if (target === undefined) continue;
    const parameters = new Map<string, string>();
    for (const match of entry.matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"([^"]*)"|([^;\s,]+))/g)) {
      parameters.set((match[1] ?? "").toLowerCase(), match[2] ?? match[3] ?? "");
    }
    const relations = (parameters.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (!relations.includes("license") || parameters.get("type")?.toLowerCase() !== RSL_MEDIA_TYPE) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new ReadError("RSL_INVALID", "An RSL Link header must use an absolute URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ReadError("RSL_INVALID", "An RSL Link header must use HTTP or HTTPS.");
    }
    urls.push(parsed.toString());
  }
  return [...new Set(urls)];
}

function htmlAssociations(body: string): Association[] {
  const document = new JSDOM(body).window.document;
  const associations: Association[] = [];
  for (const link of Array.from(document.querySelectorAll('link[rel~="license"]'))) {
    if (link.getAttribute("type")?.toLowerCase() !== RSL_MEDIA_TYPE) continue;
    const href = link.getAttribute("href");
    if (href === null) throw new ReadError("RSL_INVALID", "An HTML RSL link is missing href.");
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      throw new ReadError("RSL_INVALID", "An HTML RSL link must use an absolute URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ReadError("RSL_INVALID", "An HTML RSL link must use HTTP or HTTPS.");
    }
    associations.push({
      method: "html-link",
      licenseUrl: parsed.toString(),
      inlineXml: null,
      htmlScope: true,
    });
  }
  for (const script of Array.from(document.querySelectorAll('script[type="application/rsl+xml"]'))) {
    associations.push({
      method: "html-inline",
      licenseUrl: null,
      inlineXml: script.textContent ?? "",
      htmlScope: true,
    });
  }
  return associations;
}

function wrapRslContents(contents: Element[]): string {
  return `<rsl xmlns="${RSL_NAMESPACE}">${contents.map((content) => content.outerHTML).join("")}</rsl>`;
}

function isFeedResponse(mediaType: string, body: string): boolean {
  if (mediaType === "application/rss+xml" || mediaType === "application/atom+xml") {
    return true;
  }
  if (mediaType === "application/xml" || mediaType === "text/xml") {
    return /<(?:rss|feed)[\s>]/i.test(body);
  }
  return /^\s*<(?:rss|feed)[\s>]/i.test(body);
}

function feedAssociations(body: string, feedUrl: URL): {
  associations: Association[];
  catalog: Array<[string, string]>;
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) {
    throw new ReadError("RSL_INVALID", "RSL documents must not contain DTD or entity declarations.");
  }
  const document = new JSDOM(body, { contentType: "application/xml" }).window.document;
  const contents = Array.from(document.getElementsByTagNameNS(RSL_NAMESPACE, "content"));
  if (contents.length === 0) {
    return { associations: [], catalog: [] };
  }
  for (const element of Array.from(document.getElementsByTagNameNS(RSL_NAMESPACE, "*"))) {
    if (!KNOWN_RSL_ELEMENTS.has(element.localName)) {
      throw new ReadError("RSL_INVALID", "The RSL document contains an unknown core element.", {
        details: { element: element.localName },
      });
    }
  }
  const catalog: Array<[string, string]> = [];
  const associations: Association[] = [];
  for (const content of contents) {
    const scope = content.getAttribute("url");
    if (scope === null || directChildren(content, "license").length === 0) {
      throw new ReadError("RSL_INVALID", "Each RSL content entry must have a url and a license.");
    }
    const xml = wrapRslContents([content]);
    parseRsl(xml);
    let resolved: URL;
    try {
      resolved = new URL(scope, feedUrl);
    } catch {
      throw new ReadError("RSL_INVALID", "An RSL content scope must be a path or absolute URL.");
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      throw new ReadError("RSL_INVALID", "An RSL content scope must be a path or absolute URL.");
    }
    resolved.hash = "";
    catalog.push([resolved.toString(), xml]);
    associations.push({
      method: "rss",
      licenseUrl: null,
      inlineXml: xml,
      htmlScope: false,
    });
  }
  return { associations, catalog };
}

function outcomePriority(outcome: Outcome): number {
  return { permitted: 0, confirmation: 1, payment: 2, license: 3, prohibited: 4 }[outcome];
}

export class RslPolicy {
  private readonly cache = new Map<string, CachedRsl>();
  private readonly feedLicenses = new Map<string, string>();
  private readonly approvals: RslApprovalStore;
  private readonly olp: RslOlpClient;

  constructor(
    private readonly config: AppConfig,
    private readonly transport: HttpTransport,
  ) {
    this.approvals = new RslApprovalStore(config.rslApprovalsPath);
    this.olp = new RslOlpClient(config.rslClientsPath, transport);
  }

  get approvalContextHash(): string {
    return this.approvals.contextHash;
  }

  emptyEvidence(): RslEvidence {
    return {
      status: "not-declared",
      usage: this.config.rslUsage,
      discoveredBy: [],
      licenseUrls: [],
      licenseHashes: [],
      approvalsApplied: 0,
      licenseTokensApplied: 0,
    };
  }

  async evaluateRobots(target: URL, licenseUrls: string[]): Promise<RslEvidence> {
    return (await this.evaluate(
      target,
      licenseUrls.map((licenseUrl) => ({
        method: "robots",
        licenseUrl,
        inlineXml: null,
        htmlScope: false,
      })),
      false,
      null,
    )).evidence;
  }

  async authorizeRobots(
    target: URL,
    licenseUrls: string[],
    presentedAuthorization: string | null = null,
  ): Promise<RslAccessDecision> {
    return this.evaluate(
      target,
      licenseUrls.map((licenseUrl) => ({
        method: "robots",
        licenseUrl,
        inlineXml: null,
        htmlScope: false,
      })),
      true,
      presentedAuthorization,
    );
  }

  async evaluateResponse(target: URL, response: TransportResponse): Promise<RslEvidence> {
    return (await this.authorizeResponse(target, response, false)).evidence;
  }

  async authorizeResponse(
    target: URL,
    response: TransportResponse,
    acquireToken = true,
    presentedAuthorization: string | null = null,
    refreshPresentedToken = false,
  ): Promise<RslAccessDecision> {
    const associations: Association[] = rslLinksFromHeader(response.linkHeader).map((licenseUrl) => ({
      method: "http-link",
      licenseUrl,
      inlineXml: null,
      htmlScope: false,
    }));
    const mediaType = response.contentType.split(";", 1)[0]?.trim().toLowerCase();
    const targetKey = new URL(target);
    targetKey.hash = "";
    const remembered = this.feedLicenses.get(targetKey.toString());
    if (remembered !== undefined) {
      associations.push({
        method: "rss",
        licenseUrl: null,
        inlineXml: remembered,
        htmlScope: false,
      });
    }
    if (mediaType === RSL_MEDIA_TYPE) {
      associations.push({ method: "http-link", licenseUrl: null, inlineXml: response.body, htmlScope: false });
    } else if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
      associations.push(...htmlAssociations(response.body));
    } else if (isFeedResponse(mediaType ?? "", response.body)) {
      const feed = feedAssociations(response.body, target);
      for (const [url, xml] of feed.catalog) this.feedLicenses.set(url, xml);
      associations.push(...feed.associations);
    } else {
      for (const inlineXml of mediaContainerLicenseXml(mediaType ?? "", response.body, response.bodyBytes)) {
        associations.push({
          method: "file",
          licenseUrl: null,
          inlineXml,
          htmlScope: false,
        });
      }
    }
    return this.evaluate(
      target,
      associations,
      acquireToken,
      presentedAuthorization,
      refreshPresentedToken,
    );
  }

  private async load(association: Association): Promise<ParsedRsl> {
    if (association.inlineXml !== null) return parseRsl(association.inlineXml);
    const licenseUrl = association.licenseUrl;
    if (licenseUrl === null) {
      throw new ReadError("RSL_INVALID", "The RSL association has no document.");
    }
    const existing = this.cache.get(licenseUrl);
    if (existing !== undefined && existing.expiresAt > Date.now()) return existing.parsed;
    let response: TransportResponse;
    try {
      const parsedUrl = new URL(licenseUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("unsupported RSL URL protocol");
      }
      response = await this.transport.fetch(parsedUrl, { maxBytes: RSL_MAX_BYTES });
    } catch (error) {
      throw new ReadError("RSL_INVALID", "The declared RSL document could not be retrieved safely.", {
        details: { licenseUrl },
        cause: error,
      });
    }
    if (
      response.status !== 200 ||
      response.contentType.split(";", 1)[0]?.trim().toLowerCase() !== RSL_MEDIA_TYPE
    ) {
      throw new ReadError("RSL_INVALID", "The declared RSL URL did not return an RSL document.", {
        details: { licenseUrl, httpStatus: response.status },
      });
    }
    const parsed = parseRsl(response.body);
    this.cache.set(licenseUrl, {
      parsed,
      expiresAt: Date.now() + parsed.maxAgeDays * 86_400_000,
    });
    return parsed;
  }

  private async evaluate(
    target: URL,
    associations: Association[],
    acquireTokens: boolean,
    presentedAuthorization: string | null,
    refreshPresentedToken = false,
  ): Promise<RslAccessDecision> {
    if (associations.length === 0) {
      return { evidence: this.emptyEvidence(), authorization: null };
    }
    let effective: Outcome = "permitted";
    let applicable = false;
    const appliedApprovals = new Set<string>();
    const licenseHashes: string[] = [];
    let authorization: string | null = null;
    const tokenRequirements = new Map<string, {
      server: string;
      licenseHash: string;
      licenseXml: string;
      resource: string;
    }>();
    let blocking:
      | {
          outcome: Outcome;
          licenseHash: string;
          resource: string;
          obligations: string[];
          server: string | null;
          paymentQuote: RslPaymentQuote | null;
        }
      | null = null;
    for (const association of associations) {
      const parsed = await this.load(association);
      for (const content of applicableContents(parsed, target, association.htmlScope)) {
        applicable = true;
        for (const license of directChildren(content, "license")) {
          const hash = licenseHash(license);
          const resource = content.getAttribute("url") ?? "";
          licenseHashes.push(hash);
          let evaluation = evaluateLicense(content, license, this.config);
          if (
            evaluation.outcome === "confirmation" &&
            this.approvals.has({
              licenseHash: hash,
              resource,
              usage: this.config.rslUsage,
              userClass: this.config.rslUserClass,
              geo: this.config.rslGeo,
              obligations: evaluation.obligations,
            })
          ) {
            appliedApprovals.add(JSON.stringify([hash, resource]));
            evaluation = { ...evaluation, outcome: "permitted", obligations: [] };
          }
          let policyOutcome = evaluation.outcome;
          if (evaluation.outcome === "permitted" && evaluation.server !== null) {
            if (!acquireTokens) {
              policyOutcome = "license";
            } else {
              tokenRequirements.set(JSON.stringify([evaluation.server, hash, resource]), {
                server: evaluation.server,
                licenseHash: hash,
                licenseXml: license.outerHTML,
                resource,
              });
            }
          }
          if (outcomePriority(policyOutcome) > outcomePriority(effective)) {
            effective = policyOutcome;
            blocking = {
              outcome: policyOutcome,
              licenseHash: hash,
              resource,
              obligations: evaluation.obligations,
              server: evaluation.server,
              paymentQuote: evaluation.paymentQuote,
            };
          }
        }
      }
    }
    const evidenceBase = {
      status: applicable ? "permitted" : "not-applicable",
      usage: this.config.rslUsage,
      discoveredBy: [...new Set(associations.map((association) => association.method))],
      licenseUrls: [...new Set(associations.flatMap((association) => association.licenseUrl ?? []))],
      licenseHashes: [...new Set(licenseHashes)],
      approvalsApplied: appliedApprovals.size,
    } satisfies Omit<RslEvidence, "licenseTokensApplied">;
    if (!applicable) {
      return { evidence: { ...evidenceBase, licenseTokensApplied: 0 }, authorization: null };
    }
    const details = {
      usage: this.config.rslUsage,
      licenseUrl: evidenceBase.licenseUrls[0] ?? null,
      licenseHash: blocking?.licenseHash ?? null,
      resource: blocking?.resource ?? null,
      obligations: blocking?.obligations.join(",") ?? "",
      licenseServer: blocking?.server ?? null,
      paymentType: blocking?.paymentQuote?.paymentType ?? null,
      paymentAmount: blocking?.paymentQuote?.paymentAmount ?? null,
      paymentCurrency: blocking?.paymentQuote?.paymentCurrency ?? null,
      paymentProtocols: blocking?.paymentQuote?.paymentProtocols.join(",") ?? "",
      pricingAuthority: blocking?.paymentQuote?.pricingAuthority ?? null,
      budgetStatus: effective === "payment" ? "disabled" : null,
      settlementStatus: effective === "payment" ? "not-attempted" : null,
    };
    if (effective === "prohibited") {
      throw new ReadError("RSL_PROHIBITED", "RSL prohibits this use of the content.", { details });
    }
    if (effective === "license") {
      throw new ReadError("RSL_LICENSE_REQUIRED", "RSL requires a License Token before access.", {
        details,
      });
    }
    if (effective === "payment") {
      throw new ReadError(
        "RSL_PAYMENT_REQUIRED",
        "RSL requires payment or a custom license before access.",
        { details },
      );
    }
    if (effective === "confirmation") {
      throw new ReadError(
        "RSL_CONFIRMATION_REQUIRED",
        "RSL terms require explicit operator confirmation.",
        { details },
      );
    }
    if (tokenRequirements.size > 1) {
      const first = tokenRequirements.values().next().value;
      throw new ReadError(
        "RSL_LICENSE_REQUIRED",
        "The resource requires multiple License Tokens, which is not supported.",
        {
          details: {
            licenseHash: first?.licenseHash ?? null,
            resource: first?.resource ?? null,
          },
        },
      );
    }
    const requirement = tokenRequirements.values().next().value;
    if (requirement !== undefined) {
      if (refreshPresentedToken && presentedAuthorization !== null) {
        this.olp.invalidate(presentedAuthorization);
      }
      try {
        authorization = await this.olp.acquire(requirement);
      } catch (error) {
        if (error instanceof ReadError) {
          throw new ReadError(error.code, error.message, {
            retryable: error.retryable,
            details: {
              ...error.details,
              licenseHash: requirement.licenseHash,
              resource: requirement.resource,
            },
          });
        }
        throw error;
      }
    }
    const evidence: RslEvidence = {
      ...evidenceBase,
      licenseTokensApplied:
        authorization !== null && authorization === presentedAuthorization ? 1 : 0,
    };
    return { evidence, authorization };
  }
}
