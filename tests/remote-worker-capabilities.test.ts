import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { workerCapabilities } from "../src/remote-worker/capabilities.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workerCapabilities", () => {
  it("declares what the Reader provides without a browser", () => {
    expect(workerCapabilities({ browserExecutable: null })).toEqual({ http: true, pdf: true, feed: true });
  });

  it("declares a browser only when the configured executable exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "crawlume-worker-capabilities-"));
    directories.push(directory);
    const executable = join(directory, "chromium");
    writeFileSync(executable, "");

    expect(workerCapabilities({ browserExecutable: executable }))
      .toEqual({ http: true, pdf: true, feed: true, browser: true });
    expect(workerCapabilities({ browserExecutable: join(directory, "missing") }))
      .toEqual({ http: true, pdf: true, feed: true });
  });
});
