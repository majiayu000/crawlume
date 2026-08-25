import { chromium, type BrowserContext, type LaunchOptions } from "playwright-core";

import type { AppConfig } from "../config.js";
import { agentIdentityEvidence } from "../identity.js";
import { errorForHttpStatus, parseRetryAfterMs, ReadError } from "../errors.js";
import type { PageFetcher, RawPage } from "../types.js";
import { ProfileManager } from "../profiles.js";
import { UrlPolicy } from "../security/url-policy.js";
import type { RobotsPolicy } from "../security/robots.js";
import { ProxyPool, type ProxyEndpoint } from "../proxy.js";
import { BrowserPool, type BrowserLease } from "../browser-pool.js";
import type { RslPolicy } from "../rsl.js";

export function browserLaunchOptions(
  config: AppConfig,
  headless: boolean,
  proxy: ProxyEndpoint | null = null,
): LaunchOptions {
  const base: LaunchOptions = {
    headless,
    ...(proxy === null ? {} : { proxy: proxy.browser }),
  };
  if (config.browserExecutable !== null) {
    return { ...base, executablePath: config.browserExecutable };
  }
  return { ...base, channel: config.browserChannel };
}

function browserError(error: unknown): ReadError {
  if (error instanceof ReadError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return new ReadError("FETCH_TIMEOUT", "The browser timed out while loading the page.", {
      retryable: true,
      cause: error,
    });
  }
  if (/executable|browser.*not found|channel/i.test(message)) {
    return new ReadError("BROWSER_UNAVAILABLE", "A compatible local Chrome browser is unavailable.", {
      cause: error,
    });
  }
  return new ReadError("BROWSER_UNAVAILABLE", "The browser could not load the page.", {
    cause: error,
  });
}

export class BrowserPageFetcher implements PageFetcher {
  private readonly activeProfiles = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly urlPolicy: UrlPolicy,
    private readonly robots: RobotsPolicy,
    private readonly profiles: ProfileManager,
    private readonly rsl: RslPolicy,
    private readonly proxyPool = new ProxyPool(config.proxyEndpoints),
    private readonly browserPool = new BrowserPool(
      config,
      async (proxy) => chromium.launch(browserLaunchOptions(config, true, proxy)),
    ),
  ) {}

  async fetch(url: URL, authProfile?: string, signal?: AbortSignal): Promise<RawPage> {
    let context: BrowserContext | null = null;
    let lease: BrowserLease | null = null;
    let profilePath: string | null = null;
    const proxy = this.proxyPool.acquire(authProfile);
    let robotsRsl = this.rsl.emptyEvidence();

    if (authProfile !== undefined) {
      profilePath = this.profiles.require(authProfile);
      if (this.activeProfiles.has(authProfile)) {
        throw new ReadError("BROWSER_UNAVAILABLE", "The browser profile is already in use.", {
          retryable: true,
          details: { profile: authProfile },
        });
      }
      this.activeProfiles.add(authProfile);
    }

    try {
      await this.urlPolicy.assertPublic(url);
      await this.robots.assertAllowed(url);
      robotsRsl = await this.rsl.evaluateRobots(url, await this.robots.licenseUrls(url));

      if (profilePath !== null) {
        context = await chromium.launchPersistentContext(profilePath, {
          ...browserLaunchOptions(this.config, true, proxy),
          acceptDownloads: false,
          userAgent: this.config.userAgent,
        });
      } else {
        lease = await this.browserPool.acquire(proxy, signal);
        context = await lease.browser.newContext({
          acceptDownloads: false,
          userAgent: this.config.userAgent,
        });
      }

      const page = context.pages()[0] ?? (await context.newPage());
      let blockedNavigation: ReadError | null = null;
      await context.route("**/*", async (route) => {
        const request = route.request();
        const requestUrl = request.url();
        if (/^(about|blob|data):/.test(requestUrl)) {
          await route.continue();
          return;
        }
        try {
          const parsed = this.urlPolicy.parse(requestUrl);
          await this.urlPolicy.assertPublic(parsed);
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            await this.robots.assertAllowed(parsed);
            robotsRsl = await this.rsl.evaluateRobots(
              parsed,
              await this.robots.licenseUrls(parsed),
            );
          }
          await route.continue();
        } catch (error) {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            blockedNavigation =
              error instanceof ReadError
                ? error
                : new ReadError("SSRF_BLOCKED", "A browser navigation was blocked.", { cause: error });
          }
          await route.abort("blockedbyclient");
        }
      });

      let response;
      try {
        response = await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: this.config.browserTimeoutMs,
        });
      } catch (error) {
        if (blockedNavigation !== null) {
          throw blockedNavigation;
        }
        throw error;
      }
      if (response === null) {
        throw new ReadError("UPSTREAM_ERROR", "The browser navigation returned no response.", {
          details: { url: url.toString() },
        });
      }
      await page.waitForTimeout(750);

      const finalUrl = page.url();
      const finalParsed = this.urlPolicy.parse(finalUrl);
      await this.urlPolicy.assertPublic(finalParsed);
      const body = await page.content();
      const responseBytes = Buffer.byteLength(body);
      if (responseBytes > this.config.maxResponseBytes) {
        throw new ReadError("RESPONSE_TOO_LARGE", "The rendered page exceeded the size limit.", {
          details: {
            maxResponseBytes: this.config.maxResponseBytes,
            responseBytes,
            url: finalUrl,
          },
        });
      }

      const responseHeaders = response.headers();
      const responseMediaType = (responseHeaders["content-type"] ?? "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      let policyBody = body;
      if (responseMediaType === "application/rsl+xml") {
        const originalBody = await response.body();
        if (originalBody.byteLength > this.config.maxResponseBytes) {
          throw new ReadError("RESPONSE_TOO_LARGE", "The RSL response exceeded the size limit.", {
            details: {
              maxResponseBytes: this.config.maxResponseBytes,
              responseBytes: originalBody.byteLength,
              url: finalUrl,
            },
          });
        }
        policyBody = originalBody.toString("utf8");
      }
      const responseRsl = await this.rsl.evaluateResponse(finalParsed, {
        url: finalParsed,
        status: response.status(),
        contentType: responseHeaders["content-type"] ?? "text/html",
        body: policyBody,
        responseBytes,
        retryAfterMs: parseRetryAfterMs(responseHeaders["retry-after"] ?? null),
        proxyUsed: proxy !== null,
        agentIdentity: agentIdentityEvidence(this.config, false),
        linkHeader: responseHeaders.link ?? null,
      });
      const rsl =
        responseRsl.status === "permitted" || robotsRsl.status === "not-declared"
          ? responseRsl
          : robotsRsl;
      const statusError = errorForHttpStatus(
        response.status(),
        finalUrl,
        parseRetryAfterMs(responseHeaders["retry-after"] ?? null),
      );
      if (statusError !== null) {
        throw statusError;
      }

      return {
        body,
        fetchedAt: new Date().toISOString(),
        method: "browser",
        httpStatus: response.status(),
        contentType: response.headers()["content-type"] ?? "text/html",
        responseBytes,
        finalUrl,
        proxyUsed: proxy !== null,
        agentIdentity: agentIdentityEvidence(this.config, false),
        rsl,
      };
    } catch (error) {
      throw browserError(error);
    } finally {
      await context?.close().catch(() => undefined);
      await lease?.release();
      if (authProfile !== undefined) {
        this.activeProfiles.delete(authProfile);
      }
    }
  }

  async close(): Promise<void> {
    await this.browserPool.close();
  }
}
