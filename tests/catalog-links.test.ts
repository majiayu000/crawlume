import { describe, expect, it } from "vitest";

import { markdownCatalogLinks } from "../src/catalog-links.js";

describe("markdownCatalogLinks", () => {
  it("keeps the newest dated document paths and maps .md catalogs to pages", () => {
    const body = `# Index
- [Old tools](https://docs.example.com/specification/2025-06-18/server/tools.md)
- [Draft](https://docs.example.com/specification/draft/basic/transports.md)
- [Transports](https://docs.example.com/specification/2026-07-28/basic/transports/index.md)
- [Tools](/specification/2026-07-28/server/tools.md)
- [Seps](https://docs.example.com/seps)
- [Local](#anchor)
- [Mail](mailto:docs@example.com)
`;
    expect(markdownCatalogLinks(body, "https://docs.example.com/llms.txt")).toEqual([
      "https://docs.example.com/specification/2026-07-28/basic/transports",
      "https://docs.example.com/specification/2026-07-28/server/tools",
      "https://docs.example.com/seps",
    ]);
  });

  it("keeps an undated catalog unchanged", () => {
    const body = "- [Guide](/guide.md)\n- [Config](/config.md)\n";
    expect(markdownCatalogLinks(body, "https://vite.dev/llms.txt")).toEqual([
      "https://vite.dev/guide",
      "https://vite.dev/config",
    ]);
  });
});
