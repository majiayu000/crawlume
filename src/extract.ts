import { createHash } from "node:crypto";

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import { ReadError } from "./errors.js";
import type { ExtractedPage, RawPage } from "./types.js";

const minimumContentCharacters = 240;
const removableSelectors = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "form",
  "dialog",
  "canvas",
].join(",");

const fallbackRemovableSelectors = [
  removableSelectors,
  "nav",
  "header",
  "footer",
  "aside",
  "[role='navigation']",
  "[aria-hidden='true']",
].join(",");

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function extractLinks(body: string, baseUrl: string): string[] {
  const document = new JSDOM(body, { url: baseUrl }).window.document;
  const links = new Set<string>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const rawHref = anchor.getAttribute("href") ?? "";
    if (!URL.canParse(rawHref, document.baseURI)) {
      continue;
    }
    const href = new URL(rawHref, document.baseURI);
    if (href.protocol !== "http:" && href.protocol !== "https:") {
      continue;
    }
    href.hash = "";
    links.add(href.toString());
  }
  return [...links];
}

function errorDetails(page: RawPage, title: string, contentCharacters: number) {
  return {
    url: page.finalUrl,
    httpStatus: page.httpStatus,
    title,
    contentCharacters,
    browserRecommended: page.method === "http",
  };
}

function assertNotGatePage(document: Document, page: RawPage): void {
  const title = normalizedText(document.title);
  const bodyText = normalizedText(document.body?.textContent ?? "").slice(0, 8_000);
  const combined = `${title}\n${bodyText}`.toLowerCase();

  const challengeSignals = [
    "are you a robot",
    "verify you are human",
    "checking your browser",
    "attention required! | cloudflare",
    "security verification",
    "captcha",
    "unusual traffic",
  ];
  if (challengeSignals.some((signal) => combined.includes(signal))) {
    throw new ReadError(
      "HUMAN_VERIFICATION_REQUIRED",
      "The site returned a human-verification or bot-challenge page.",
      { details: errorDetails(page, title, bodyText.length) },
    );
  }

  if (/\b(log in|sign in)\b.*\b(sign up|join)\b/i.test(title) || /^(log in|sign in)$/i.test(title)) {
    throw new ReadError("LOGIN_WALL_DETECTED", "The site returned a login wall.", {
      details: errorDetails(page, title, bodyText.length),
    });
  }

  const paywallNode = document.querySelector(
    "[class*='paywall' i], [id*='paywall' i], [data-testid*='paywall' i], [class*='metered' i]",
  );
  const paywallPhrase =
    /subscribe to (continue|read)|subscription required|you have reached your (article|story) limit|members only/i;
  if (paywallNode !== null && paywallPhrase.test(bodyText)) {
    throw new ReadError("PAYMENT_REQUIRED", "The site returned a subscription wall.", {
      details: errorDetails(page, title, bodyText.length),
    });
  }
}

function sanitizeDocument(document: Document, baseUrl: string, fallback: boolean): void {
  document.querySelectorAll(fallback ? fallbackRemovableSelectors : removableSelectors).forEach((node) => {
    node.remove();
  });

  for (const element of document.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
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
      if (source.protocol === "http:" || source.protocol === "https:") {
        image.src = source.toString();
      } else {
        image.removeAttribute("src");
      }
    } catch {
      image.removeAttribute("src");
    }
  }
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  const contentDom = new JSDOM(html, { url: baseUrl });
  sanitizeDocument(contentDom.window.document, baseUrl, false);
  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });
  turndown.remove(["button", "input", "select", "textarea"]);
  return cleanMarkdown(turndown.turndown(contentDom.window.document.body));
}

function extractPlain(page: RawPage): ExtractedPage {
  const markdown = cleanMarkdown(page.body);
  if (markdown.length < minimumContentCharacters) {
    throw new ReadError("INCOMPLETE_CONTENT", "The response did not contain enough readable content.", {
      details: errorDetails(page, page.finalUrl, markdown.length),
    });
  }
  return {
    title: page.finalUrl,
    byline: null,
    publishedTime: null,
    markdown,
    contentCharacters: markdown.length,
    contentHash: contentHash(markdown),
    extractionMethod: "plain",
    links: [],
  };
}

export function extractPage(page: RawPage): ExtractedPage {
  const contentType = page.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    contentType === "text/plain" ||
    contentType === "application/json" ||
    contentType.endsWith("+json")
  ) {
    return extractPlain(page);
  }
  if (
    contentType !== "" &&
    contentType !== "text/html" &&
    contentType !== "application/xhtml+xml"
  ) {
    throw new ReadError("UNSUPPORTED_CONTENT_TYPE", "The response is not a supported text page.", {
      details: { contentType, url: page.finalUrl },
    });
  }

  const dom = new JSDOM(page.body, { url: page.finalUrl });
  const document = dom.window.document;
  const links = extractLinks(page.body, page.finalUrl);
  assertNotGatePage(document, page);

  const title = normalizedText(document.title) || page.finalUrl;
  const cloned = document.cloneNode(true) as Document;
  sanitizeDocument(cloned, page.finalUrl, false);
  const article = new Readability(cloned).parse();

  let markdown = "";
  let extractionMethod: "readability" | "document" = "readability";
  if (article?.content !== null && article?.content !== undefined) {
    markdown = htmlToMarkdown(article.content, page.finalUrl);
  }

  if (markdown.length < minimumContentCharacters) {
    const fallback = document.cloneNode(true) as Document;
    sanitizeDocument(fallback, page.finalUrl, true);
    const turndown = new TurndownService({
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      headingStyle: "atx",
    });
    turndown.remove(["button", "input", "select", "textarea"]);
    markdown = cleanMarkdown(turndown.turndown(fallback.body));
    extractionMethod = "document";
  }

  const bodyText = normalizedText(document.body?.textContent ?? "");
  const looksLikeShell =
    /enable javascript|javascript is disabled|loading(?:\.{3}|…)|something went wrong/i.test(bodyText) ||
    (bodyText.length < minimumContentCharacters && document.querySelectorAll("script").length > 3);
  if (looksLikeShell && markdown.length < 2_000) {
    throw new ReadError("SHELL_ONLY", "The page returned an application shell without complete data.", {
      details: errorDetails(page, title, markdown.length),
    });
  }
  if (markdown.length < minimumContentCharacters) {
    throw new ReadError("INCOMPLETE_CONTENT", "The page did not contain enough readable content.", {
      details: errorDetails(page, title, markdown.length),
    });
  }

  return {
    title: normalizedText(article?.title ?? "") || title,
    byline: normalizedText(article?.byline ?? "") || null,
    publishedTime: normalizedText(article?.publishedTime ?? "") || null,
    markdown,
    contentCharacters: markdown.length,
    contentHash: contentHash(markdown),
    extractionMethod,
    links,
  };
}
