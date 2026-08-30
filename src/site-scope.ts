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

export function normalizeDiscoveredLink(
  rawUrl: string,
  parent: DiscoveredUrl,
  scope: SiteScope,
): DiscoveredUrl | null {
  const url = normalizeSiteCandidate(rawUrl, scope);
  return url === null
    ? null
    : { url, depth: parent.depth + 1, discoveredFrom: parent.url };
}
