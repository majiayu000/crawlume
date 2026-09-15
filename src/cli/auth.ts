#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { chromium } from "playwright-core";

import { loadConfig } from "../config.js";
import { browserLaunchOptions } from "../fetch/browser.js";
import { HttpTransport } from "../fetch/http.js";
import { ProfileManager } from "../profiles.js";
import { ProxyPool } from "../proxy.js";
import { RobotsPolicy } from "../security/robots.js";
import { UrlPolicy } from "../security/url-policy.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const profileName = argument("--profile");
  const inputUrl = argument("--url");
  if (profileName === null || inputUrl === null) {
    throw new Error("Usage: pnpm auth --profile <name> --url <https://site.example/login>");
  }

  const config = loadConfig();
  const profiles = new ProfileManager(config);
  const proxyPool = new ProxyPool(config.proxyEndpoints);
  const urlPolicy = new UrlPolicy(undefined, config.allowDnsFakeIp);
  const transport = new HttpTransport(config, urlPolicy, proxyPool);
  const robots = new RobotsPolicy(config, transport);
  const url = urlPolicy.parse(inputUrl);

  try {
    await urlPolicy.assertPublic(url);
    await robots.assertAllowed(url);
    const profilePath = profiles.create(profileName);
    const context = await chromium.launchPersistentContext(profilePath, {
      ...browserLaunchOptions(config, false, proxyPool.acquire(profileName)),
      acceptDownloads: false,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: config.browserTimeoutMs,
      });
      stdout.write(
        `Browser profile "${profileName}" is open. Log in manually, then return here.\n`,
      );
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        await prompt.question("Press Enter after login is complete: ");
      } finally {
        prompt.close();
      }
    } finally {
      await context.close();
    }
    stdout.write(`Saved profile "${profileName}" outside the repository.\n`);
  } finally {
    await transport.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`crawlume-auth failed: ${message}\n`);
  process.exitCode = 1;
});
