export function loadFixture(fixture) {
  if (!Array.isArray(fixture?.cases) || fixture.cases.length === 0) {
    throw new Error("A docs-trial fixture requires at least one case.");
  }
  const mode = fixture.mode === "discovery" ? "discovery" : "exact";
  if (mode === "discovery") {
    if (!Array.isArray(fixture.sites) || fixture.sites.length === 0) {
      throw new Error("A discovery fixture requires official site seeds.");
    }
    for (const site of fixture.sites) {
      if (!site?.id || !site?.seedUrl) {
        throw new Error("Each discovery site requires id and seedUrl.");
      }
      new URL(site.seedUrl);
    }
  }
  for (const item of fixture.cases) {
    if (!item?.id || !item?.url || !item?.question || !item?.agentQuery) {
      throw new Error("Each case requires id, url, question, and agentQuery.");
    }
    new URL(item.url);
  }
  return { ...fixture, mode };
}

export function applySeeds(verticalSearch, fixture) {
  if (fixture.mode === "discovery") {
    return fixture.sites.map((site) => verticalSearch.addOfficialDomain(site.seedUrl));
  }
  return fixture.cases.map((item) => verticalSearch.addManualUrl(item.url));
}

export function canonicalizeUrl(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

export function matchGoldPublication(item, publications) {
  const target = canonicalizeUrl(item.url);
  return publications.find((page) => {
    const urls = [page.url, page.result?.finalUrl].filter(Boolean).map((url) => canonicalizeUrl(url));
    return urls.includes(target);
  }) ?? null;
}
