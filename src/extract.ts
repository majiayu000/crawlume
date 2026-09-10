import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import { defaultSiteAdapterRegistry, type SiteAdapterRegistry } from "./adapters.js";
import { normalizeError, ReadError, type ReadErrorCode } from "./errors.js";
import type { ExtractedPage, ExtractionMethod, RawPage } from "./types.js";

const removableSelectors = [
  "script", "style", "noscript", "template", "iframe", "object", "embed", "form",
  "dialog", "canvas", "button", "input", "select", "textarea",
].join(",");
const fallbackRemovableSelectors = [
  removableSelectors, "nav", "header", "footer", "aside", "[role='navigation']",
  "[aria-hidden='true']",
].join(",");
const pdfjsDirectory = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const standardFontDataUrl = join(pdfjsDirectory, "standard_fonts") + sep;

export type ExtractionCandidate = {
  extractorId: string;
  extractorVersion: string;
  artifact: ExtractedPage;
};

export type ExtractionAttempt = {
  extractorId: string;
  extractorVersion: string;
  outcome: "candidate" | "not-applicable" | "failed";
  errorCode: ReadErrorCode | null;
};

export type ExtractionBatch = {
  candidates: ExtractionCandidate[];
  attempts: ExtractionAttempt[];
};

export type CandidateExtractor = {
  id: string;
  version: string;
  supports(page: RawPage): boolean;
  extract(page: RawPage): ExtractedPage | null | Promise<ExtractedPage | null>;
};

function mediaType(page: RawPage): string {
  return page.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/\r\n/gu, "\n")
    .trim();
}

function artifact(
  page: RawPage,
  method: ExtractionMethod,
  markdown: string,
  options: {
    title?: string;
    byline?: string | null;
    publishedTime?: string | null;
    links?: string[];
  } = {},
): ExtractedPage {
  const cleaned = cleanMarkdown(markdown);
  return {
    title: normalizedText(options.title ?? "") || page.finalUrl,
    byline: options.byline ?? null,
    publishedTime: options.publishedTime ?? null,
    markdown: cleaned,
    contentCharacters: cleaned.length,
    contentHash: createHash("sha256").update(cleaned).digest("hex"),
    extractionMethod: method,
    links: [...new Set(options.links ?? [])],
  };
}

type HtmlExtractionState = {
  document: Document;
  links: string[];
  articleCandidate?: ExtractedPage | null;
};

const htmlExtractionStates = new WeakMap<RawPage, HtmlExtractionState>();

function documentLinks(document: Document): string[] {
  const links = new Set<string>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const rawHref = anchor.getAttribute("href") ?? "";
    if (!URL.canParse(rawHref, document.baseURI)) continue;
    const href = new URL(rawHref, document.baseURI);
    if (href.protocol !== "http:" && href.protocol !== "https:") continue;
    href.hash = "";
    links.add(href.toString());
  }
  return [...links];
}

function htmlExtractionState(page: RawPage): HtmlExtractionState {
  const existing = htmlExtractionStates.get(page);
  if (existing !== undefined) return existing;
  const document = new JSDOM(page.body, { url: page.finalUrl }).window.document;
  const state = { document, links: documentLinks(document) };
  htmlExtractionStates.set(page, state);
  return state;
}

export class ExtractorRegistry {
  constructor(
    private readonly extractors: readonly CandidateExtractor[],
    private readonly siteAdapters: SiteAdapterRegistry = defaultSiteAdapterRegistry,
  ) {}

  async extract(page: RawPage): Promise<ExtractionBatch> {
    return this.extractCandidates(page, false);
  }

  async extractForTournament(page: RawPage): Promise<ExtractionBatch> {
    return this.extractCandidates(page, true);
  }

  private async extractCandidates(
    page: RawPage,
    includeDocumentFallback: boolean,
  ): Promise<ExtractionBatch> {
    const candidates: ExtractionCandidate[] = [];
    const attempts: ExtractionAttempt[] = [];
    let matched = 0;
    let firstFailure: ReadError | null = null;
    const siteAdapter = this.siteAdapters.resolve(page.finalUrl);
    if (siteAdapter !== null) {
      const extractorId = `adapter:${siteAdapter.manifest.id}`;
      const extractorVersion = `${extractorId}@${siteAdapter.manifest.version}`;
      matched += 1;
      try {
        const result = await this.siteAdapters.extract(page.finalUrl, page);
        attempts.push({
          extractorId,
          extractorVersion,
          outcome: result === null ? "not-applicable" : "candidate",
          errorCode: null,
        });
        if (result !== null) {
          candidates.push({ extractorId, extractorVersion, artifact: result.artifact });
        }
      } catch (error) {
        const normalized = normalizeError(error);
        firstFailure = normalized;
        attempts.push({
          extractorId,
          extractorVersion,
          outcome: "failed",
          errorCode: normalized.code,
        });
      }
    }
    for (const extractor of this.extractors) {
      const tournamentDocument = includeDocumentFallback && extractor.id === "document" &&
        htmlMediaTypes.has(mediaType(page));
      if (!extractor.supports(page) && !tournamentDocument) continue;
      matched += 1;
      try {
        const extracted = await extractor.extract(page);
        attempts.push({
          extractorId: extractor.id,
          extractorVersion: extractor.version,
          outcome: extracted === null ? "not-applicable" : "candidate",
          errorCode: null,
        });
        if (extracted !== null) {
          candidates.push({
            extractorId: extractor.id,
            extractorVersion: extractor.version,
            artifact: extracted,
          });
        }
      } catch (error) {
        const normalized = normalizeError(error);
        firstFailure ??= normalized;
        attempts.push({
          extractorId: extractor.id,
          extractorVersion: extractor.version,
          outcome: "failed",
          errorCode: normalized.code,
        });
      }
    }
    if (matched === 0) {
      throw new ReadError("UNSUPPORTED_CONTENT_TYPE", "No extractor supports the response media type.", {
        details: { contentType: page.contentType, url: page.finalUrl },
      });
    }
    if (candidates.length === 0) {
      throw firstFailure ?? new ReadError(
        "INCOMPLETE_CONTENT",
        "The matching extractors produced no candidate artifact.",
        { details: { contentType: page.contentType, url: page.finalUrl } },
      );
    }
    return { candidates, attempts };
  }
}

export function extractLinks(body: string, baseUrl: string): string[] {
  const document = new JSDOM(body, { url: baseUrl }).window.document;
  return documentLinks(document);
}

function codeText(node: Node, root: Node = node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  if (element.tagName === "BR") return "\n";
  const text = Array.from(node.childNodes, (child) => codeText(child, root)).join("");
  return element.parentNode === root && (element.tagName === "DIV" || element.tagName === "P") && !text.endsWith("\n")
    ? `${text}\n`
    : text;
}

function normalizeCodeBlocks(document: Document): void {
  for (const pre of document.querySelectorAll("pre")) {
    const existing = pre.querySelector("code");
    const language = /\blanguage-([\w+-]+)/u.exec(`${existing?.className ?? ""} ${pre.className}`)?.[1]
      ?? existing?.getAttribute("language") ?? pre.getAttribute("language");
    const code = document.createElement("code");
    const source = existing ?? pre;
    source.querySelectorAll("[hidden], [aria-hidden='true'], [role='tooltip']")
      .forEach((node) => node.remove());
    // Twoslash annotations/diagnostics belong beside the source, not inside it.
    const annotations = Array.from(source.querySelectorAll(":scope > .meta-line, :scope > .error"), (node) => {
      const quote = document.createElement("blockquote");
      quote.textContent = node.textContent?.trim() ?? "";
      return quote;
    });
    source.querySelectorAll(":scope > .meta-line, :scope > .error, :scope > .error-behind")
      .forEach((node) => node.remove());
    code.textContent = codeText(source);
    if (language !== null && language !== undefined && /^[\w+-]+$/u.test(language)) {
      code.className = `language-${language}`;
    }
    pre.replaceChildren(code);

    // A scroll/style wrapper must not make Readability discard its only content.
    let wrapper: Element = pre;
    while (wrapper.parentElement?.tagName === "DIV") {
      const parent = wrapper.parentElement;
      if (parent.children.length !== 1 || parent.textContent?.trim() !== pre.textContent?.trim() ||
          parent.hidden || parent.getAttribute("aria-hidden") === "true" ||
          parent.style.display === "none" || parent.style.visibility === "hidden") break;
      wrapper = parent;
    }
    if (wrapper !== pre) wrapper.replaceWith(pre);
    pre.after(...annotations);
  }
}

function sanitizeDocument(document: Document, baseUrl: string, fallback: boolean): void {
  document.querySelectorAll(fallback ? fallbackRemovableSelectors : removableSelectors)
    .forEach((node) => node.remove());
  for (const element of document.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
    }
  }
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    try {
      const href = new URL(anchor.getAttribute("href") ?? "", baseUrl);
      if (href.protocol === "http:" || href.protocol === "https:" || href.protocol === "mailto:") {
        anchor.href = href.toString();
      } else {
        anchor.removeAttribute("href");
      }
    } catch {
      anchor.removeAttribute("href");
    }
  }
  for (const image of document.querySelectorAll<HTMLImageElement>("img[src]")) {
    try {
      const source = new URL(image.getAttribute("src") ?? "", baseUrl);
      if (source.protocol === "http:" || source.protocol === "https:") image.src = source.toString();
      else image.removeAttribute("src");
    } catch {
      image.removeAttribute("src");
    }
  }
}

function htmlToMarkdown(document: Document, baseUrl: string, fallback: boolean): string {
  const clone = document.cloneNode(true) as Document;
  sanitizeDocument(clone, baseUrl, fallback);
  normalizeCodeBlocks(clone);
  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });
  return cleanMarkdown(turndown.turndown(clone.body));
}

function jsonExtractor(page: RawPage): ExtractedPage {
  let value: unknown;
  try {
    value = JSON.parse(page.body) as unknown;
  } catch (cause) {
    throw new ReadError("INCOMPLETE_CONTENT", "The response declared JSON but was malformed.", {
      details: { url: page.finalUrl },
      cause,
    });
  }
  const title = value !== null && typeof value === "object" && "title" in value &&
      typeof value.title === "string"
    ? value.title
    : page.finalUrl;
  return artifact(page, "json", `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``, { title });
}

function jsonLdExtractor(page: RawPage): ExtractedPage | null {
  const { document } = htmlExtractionState(page);
  const values: unknown[] = [];
  for (const script of document.querySelectorAll<HTMLScriptElement>("script[type='application/ld+json' i]")) {
    try {
      const parsed = JSON.parse(script.textContent ?? "") as unknown;
      values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      continue;
    }
  }
  const expanded = values.flatMap((value) => {
    if (value !== null && typeof value === "object" && "@graph" in value && Array.isArray(value["@graph"])) {
      return value["@graph"] as unknown[];
    }
    return [value];
  });
  const articleValue = expanded.find((value) => {
    if (value === null || typeof value !== "object" || !("@type" in value)) return false;
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    return types.some((type) => typeof type === "string" && /article|report|news/iu.test(type));
  });
  if (articleValue === undefined || articleValue === null || typeof articleValue !== "object") return null;
  const record = articleValue as Record<string, unknown>;
  const title = typeof record.headline === "string"
    ? record.headline
    : typeof record.name === "string" ? record.name : page.finalUrl;
  const body = typeof record.articleBody === "string" && record.articleBody.trim() !== ""
    ? record.articleBody
    : typeof record.text === "string" ? record.text : "";
  // Headline/description metadata cannot replace the document's full content.
  if (body.trim() === "") return null;
  const authorValue = record.author;
  const byline = typeof authorValue === "string"
    ? authorValue
    : authorValue !== null && typeof authorValue === "object" && "name" in authorValue &&
        typeof authorValue.name === "string"
      ? authorValue.name
      : null;
  const publishedTime = typeof record.datePublished === "string" ? record.datePublished : null;
  const links = typeof record.url === "string" && URL.canParse(record.url, page.finalUrl)
    ? [new URL(record.url, page.finalUrl).toString()]
    : [];
  return artifact(page, "json-ld", `# ${title}\n\n${body}`, {
    title,
    byline,
    publishedTime,
    links,
  });
}

function xmlDocument(page: RawPage): Document {
  return new JSDOM(page.body, { contentType: "application/xml", url: page.finalUrl }).window.document;
}

function feedExtractor(page: RawPage, kind: "rss" | "atom"): ExtractedPage {
  const document = xmlDocument(page);
  const root = kind === "rss" ? document.querySelector("channel") : document.documentElement;
  const title = normalizedText(root?.querySelector("title")?.textContent ?? "") || page.finalUrl;
  const entries = [...document.querySelectorAll(kind === "rss" ? "item" : "entry")];
  const links: string[] = [];
  const sections = entries.map((entry) => {
    const entryTitle = normalizedText(entry.querySelector("title")?.textContent ?? "Untitled entry");
    const rawLink = kind === "rss"
      ? entry.querySelector("link")?.textContent ?? ""
      : entry.querySelector("link[href]")?.getAttribute("href") ?? "";
    const link = URL.canParse(rawLink, page.finalUrl) ? new URL(rawLink, page.finalUrl).toString() : "";
    if (link !== "") links.push(link);
    const summary = normalizedText(
      entry.querySelector(kind === "rss" ? "description" : "summary, content")?.textContent ?? "",
    );
    return `## ${entryTitle}\n\n${link === "" ? "" : `${link}\n\n`}${summary}`;
  });
  return artifact(page, kind, `# ${title}\n\n${sections.join("\n\n")}`, { title, links });
}

function sitemapExtractor(page: RawPage): ExtractedPage {
  const document = xmlDocument(page);
  const links = [...document.querySelectorAll("loc")]
    .map((node) => normalizedText(node.textContent ?? ""))
    .filter((value) => URL.canParse(value))
    .map((value) => new URL(value).toString());
  return artifact(page, "sitemap", links.map((link) => `- ${link}`).join("\n"), {
    title: "Sitemap",
    links,
  });
}

async function pdfExtractor(page: RawPage): Promise<ExtractedPage> {
  if (page.bodyBytes === undefined) {
    throw new ReadError("INCOMPLETE_CONTENT", "PDF extraction requires the original response bytes.", {
      details: { url: page.finalUrl },
    });
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: page.bodyBytes.slice(), standardFontDataUrl });
  const document = await loading.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const pdfPage = await document.getPage(pageNumber);
      const text = await pdfPage.getTextContent();
      pages.push(text.items
        .map((item) => "str" in item && typeof item.str === "string" ? item.str : "")
        .join(" "));
      pdfPage.cleanup();
    }
    return artifact(page, "pdf", pages.join("\n\n"));
  } finally {
    await loading.destroy();
  }
}

function articleExtractor(page: RawPage): ExtractedPage | null {
  const state = htmlExtractionState(page);
  const { document } = state;
  const clone = document.cloneNode(true) as Document;
  sanitizeDocument(clone, page.finalUrl, false);
  normalizeCodeBlocks(clone);
  const article = new Readability(clone, {
    classesToPreserve: [...new Set(Array.from(clone.querySelectorAll("pre > code"), (code) => code.className))],
  }).parse();
  if (article?.content === null || article?.content === undefined) {
    state.articleCandidate = null;
    return null;
  }
  const contentDocument = new JSDOM(article.content, { url: page.finalUrl }).window.document;
  const candidate = artifact(page, "readability", htmlToMarkdown(contentDocument, page.finalUrl, false), {
    title: normalizedText(article.title ?? "") || normalizedText(document.title),
    byline: normalizedText(article.byline ?? "") || null,
    publishedTime: normalizedText(article.publishedTime ?? "") || null,
    links: state.links,
  });
  state.articleCandidate = candidate;
  return candidate;
}

function documentExtractor(page: RawPage): ExtractedPage {
  const { document, links } = htmlExtractionState(page);
  return artifact(page, "document", htmlToMarkdown(document, page.finalUrl, true), {
    title: normalizedText(document.title),
    links,
  });
}

function startsWithBytes(page: RawPage, signature: string): boolean {
  if (page.bodyBytes === undefined || page.bodyBytes.byteLength < signature.length) return false;
  return signature.split("").every((character, index) => page.bodyBytes?.[index] === character.charCodeAt(0));
}

const htmlMediaTypes = new Set(["", "text/html", "application/xhtml+xml"]);
const extractors: CandidateExtractor[] = [
  {
    id: "json", version: "json-v1",
    supports: (page) => mediaType(page) === "application/json" || mediaType(page).endsWith("+json"),
    extract: jsonExtractor,
  },
  {
    id: "json-ld", version: "json-ld-v2",
    supports: (page) => htmlMediaTypes.has(mediaType(page)) &&
      /<script[^>]+type=["']application\/ld\+json["']/iu.test(page.body),
    extract: jsonLdExtractor,
  },
  {
    id: "rss", version: "rss-v1",
    supports: (page) => mediaType(page) === "application/rss+xml" || /<rss(?:\s|>)/iu.test(page.body),
    extract: (page) => feedExtractor(page, "rss"),
  },
  {
    id: "atom", version: "atom-v1",
    supports: (page) => mediaType(page) === "application/atom+xml" || /<feed(?:\s|>)/iu.test(page.body),
    extract: (page) => feedExtractor(page, "atom"),
  },
  {
    id: "sitemap", version: "sitemap-v1",
    supports: (page) => /<(?:urlset|sitemapindex)(?:\s|>)/iu.test(page.body),
    extract: sitemapExtractor,
  },
  {
    id: "pdf", version: "pdfjs-v1",
    supports: (page) => mediaType(page) === "application/pdf" || startsWithBytes(page, "%PDF-"),
    extract: pdfExtractor,
  },
  {
    id: "article", version: "readability-v2",
    supports: (page) => htmlMediaTypes.has(mediaType(page)),
    extract: articleExtractor,
  },
  {
    id: "document", version: "document-v2",
    supports: (page) => {
      if (!htmlMediaTypes.has(mediaType(page))) return false;
      const candidate = htmlExtractionState(page).articleCandidate;
      return candidate === undefined || candidate === null || candidate.contentCharacters < 240;
    },
    extract: documentExtractor,
  },
  {
    id: "plain", version: "plain-v1",
    supports: (page) => {
      const type = mediaType(page);
      return type === "text/plain" || type === "text/markdown";
    },
    extract: (page) => artifact(page, "plain", page.body),
  },
];

export const defaultExtractorRegistry = new ExtractorRegistry(extractors);
