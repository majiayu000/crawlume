import { describe, expect, it } from "vitest";

import {
  createSiteScope,
  normalizeDiscoveredLink,
} from "../src/site-scope.js";

const parent = {
  url: "https://example.com/guide",
  depth: 0,
  discoveredFrom: null,
};
const scope = createSiteScope(new URL("https://example.com/"), {
  url: "https://example.com/",
  includeSubdomains: false,
  ignoreQueryParameters: true,
});

describe("normalizeDiscoveredLink", () => {
  it("keeps document paths and skips static asset files", () => {
    expect(normalizeDiscoveredLink("https://example.com/docs/intro", parent, scope)).toEqual({
      url: "https://example.com/docs/intro",
      depth: 1,
      discoveredFrom: parent.url,
    });
    expect(normalizeDiscoveredLink("https://example.com/llms.txt", parent, scope)).toMatchObject({
      url: "https://example.com/llms.txt",
    });
    expect(normalizeDiscoveredLink("https://example.com/spec.pdf", parent, scope)).toMatchObject({
      url: "https://example.com/spec.pdf",
    });

    expect(normalizeDiscoveredLink(
      "https://example.com/static/TypeScript%20Classes-abc.png",
      parent,
      scope,
    )).toBeNull();
    expect(normalizeDiscoveredLink("https://example.com/assets/cheatsheets.zip", parent, scope))
      .toBeNull();
    expect(normalizeDiscoveredLink("https://example.com/app.js", parent, scope)).toBeNull();
    expect(normalizeDiscoveredLink("https://example.com/theme.css", parent, scope)).toBeNull();
  });
});
