function catalogDocumentUrl(rawHref: string, baseUrl: string): string | null {
  const trimmed = rawHref.trim();
  if (trimmed === "" || trimmed.startsWith("#") || !URL.canParse(trimmed, baseUrl)) return null;
  const href = new URL(trimmed, baseUrl);
  if (href.protocol !== "http:" && href.protocol !== "https:") return null;
  href.hash = "";
  if (href.pathname.toLowerCase().endsWith(".md")) {
    href.pathname = href.pathname.slice(0, -3);
    if (href.pathname.endsWith("/index")) {
      href.pathname = href.pathname.slice(0, -"/index".length) || "/";
    }
  }
  const base = new URL(baseUrl);
  base.hash = "";
  const normalized = href.toString();
  return normalized === base.toString() ? null : normalized;
}

function pathDates(pathname: string): string[] {
  return [...pathname.matchAll(/\/(\d{4}-\d{2}-\d{2})(?=\/|$)/g)].map((match) => match[1] ?? "");
}

function preferCurrentCatalogVersions(urls: string[]): string[] {
  const dated = urls.flatMap((url) => pathDates(new URL(url).pathname));
  if (dated.length === 0) return urls;
  const latest = dated.reduce((current, value) => (value > current ? value : current));
  return urls.filter((url) => {
    const pathname = new URL(url).pathname;
    const dates = pathDates(pathname);
    if (dates.some((value) => value < latest)) return false;
    return dates.length > 0 || !/\/draft(?:\/|$)/i.test(pathname);
  });
}

export function markdownCatalogLinks(body: string, baseUrl: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const labeled = /\[[^\]]*\]\(\s*<?([^>\s)]+)>?\s*\)/g;
  const autolink = /<(https?:\/\/[^>\s]+)>/gi;
  for (const match of [...body.matchAll(labeled), ...body.matchAll(autolink)]) {
    const href = catalogDocumentUrl(match[1] ?? "", baseUrl);
    if (href === null || seen.has(href)) continue;
    seen.add(href);
    links.push(href);
  }
  return preferCurrentCatalogVersions(links);
}
