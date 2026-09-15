import type { DiscoveredUrl, SiteScopeOptions } from "./types.js";

export type SiteScope = {
  hostname: string;
  includeSubdomains: boolean;
  ignoreQueryParameters: boolean;
};

export function createSiteScope(root: URL, options: SiteScopeOptions): SiteScope {
  return {
    hostname: root.hostname,
    includeSubdomains: options.includeSubdomains ?? false,
    ignoreQueryParameters: options.ignoreQueryParameters ?? true,
  };
}

export function normalizeSiteCandidate(rawUrl: string, scope: SiteScope): string | null {
  if (!URL.canParse(rawUrl)) return null;
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const inScope = url.hostname === scope.hostname ||
    (scope.includeSubdomains && url.hostname.endsWith(`.${scope.hostname}`));
  if (!inScope) return null;
  url.hash = "";
  if (scope.ignoreQueryParameters) url.search = "";
  return url.toString();
}

export function siteSourceUrl(root: URL, scope: SiteScope): string {
  return normalizeSiteCandidate(root.toString(), scope) ?? root.toString();
}

const skippedDiscoveryExtensions = new Set([
  "7z", "avi", "avif", "bin", "bmp", "bz2", "cjs", "css", "dmg", "eot", "exe",
  "gif", "gz", "ico", "iso", "jpeg", "jpg", "js", "map", "mjs", "mkv", "mov",
  "mp3", "mp4", "ogg", "otf", "pkg", "png", "rar", "svg", "tar", "tgz", "tif",
  "tiff", "ttf", "wasm", "wav", "webm", "webp", "woff", "woff2", "zip",
]);

function isStaticAssetUrl(url: string): boolean {
  const last = new URL(url).pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) return false;
  return skippedDiscoveryExtensions.has(last.slice(dot + 1).toLowerCase());
}

export function normalizeDiscoveredLink(
  rawUrl: string,
  parent: DiscoveredUrl,
  scope: SiteScope,
): DiscoveredUrl | null {
  const url = normalizeSiteCandidate(rawUrl, scope);
  if (url === null || isStaticAssetUrl(url)) return null;
  return { url, depth: parent.depth + 1, discoveredFrom: parent.url };
}
