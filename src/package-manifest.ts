import { readFileSync } from "node:fs";

export type PackageManifest = { version: string; bugsUrl: string };

export function packageManifest(): PackageManifest {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
    bugs?: { url?: unknown };
  };
  if (typeof manifest.version !== "string") throw new Error("package.json has no version.");
  if (typeof manifest.bugs?.url !== "string") throw new Error("package.json has no bugs.url.");
  return { version: manifest.version, bugsUrl: manifest.bugs.url };
}
