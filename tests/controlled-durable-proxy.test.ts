import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { createDurableCrawlSite } from "../benchmarks/controlled-site/durable-crawl.js";

describe("controlled crawl proxy", () => {
  it("handles peer resets after rejecting a CONNECT tunnel", async () => {
    const site = await createDurableCrawlSite({ pages: 1 });
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: Number(new URL(site.proxyUrl).port) }, () => {
          socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        });
        socket.once("error", reject);
        socket.once("data", (data: Buffer) => {
          try {
            expect(data.toString()).toContain("405 Method Not Allowed");
            socket.resetAndDestroy();
          } catch (error) { socket.destroy(); reject(error); }
        });
        socket.once("close", () => resolve());
      });
      // Give the server's asynchronous read error a turn before fixture teardown.
      await delay(20);
    } finally { await site.close(); }
  });
});
