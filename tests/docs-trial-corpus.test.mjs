import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  applySeeds,
  canonicalizeUrl,
  loadFixture,
  matchGoldPublication,
} from "../benchmarks/docs-trial/corpus.mjs";

const exact = loadFixture(JSON.parse(
  readFileSync(new URL("../benchmarks/docs-trial/cases.json", import.meta.url), "utf8"),
));
const discovery = loadFixture(JSON.parse(
  readFileSync(new URL("../benchmarks/docs-trial/discovery.json", import.meta.url), "utf8"),
));

describe("docs-trial corpus fixtures", () => {
  it("keeps the exact-URL fixture as twenty gold pages", () => {
    expect(exact.mode).toBe("exact");
    expect(exact.cases).toHaveLength(20);
    expect(exact.sites).toBeUndefined();
  });

  it("seeds discovery from official domains instead of exact gold URLs", () => {
    const added = [];
    applySeeds({
      addOfficialDomain: (url) => {
        added.push(url);
        return { url };
      },
      addManualUrl: () => {
        throw new Error("discovery must not seed exact gold URLs");
      },
    }, discovery);

    expect(discovery.mode).toBe("discovery");
    expect(discovery.sites).toHaveLength(5);
    expect(discovery.cases).toHaveLength(20);
    expect(added).toEqual(discovery.sites.map((site) => site.seedUrl));
  });

  it("matches a discovered gold page by requested or final URL", () => {
    const item = discovery.cases.find((entry) => entry.id === "vite-1");
    const publications = [
      {
        url: "https://vite.dev/guide/",
        result: { finalUrl: canonicalizeUrl(item.url), contentMarkdown: "env" },
      },
    ];
    expect(matchGoldPublication(item, publications)?.result?.finalUrl).toBe(canonicalizeUrl(item.url));
    expect(matchGoldPublication(item, [])).toBeNull();
  });
});
