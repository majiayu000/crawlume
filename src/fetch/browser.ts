import { chromium, type BrowserContext, type LaunchOptions, type Page } from "playwright-core";

import type { AppConfig } from "../config.js";
import { agentIdentityEvidence } from "../identity.js";
import {
  crawlCancelledError,
  errorForHttpStatus,
  parseRetryAfterMs,
  ReadError,
} from "../errors.js";
import type { PageFetchOptions, PageFetcher, RawPage } from "../types.js";
import { ProfileManager } from "../profiles.js";
import { UrlPolicy } from "../security/url-policy.js";
import type { RobotsPolicy } from "../security/robots.js";
import { ProxyPool, type ProxyEndpoint } from "../proxy.js";
import { BrowserPool, type BrowserLease } from "../browser-pool.js";
import type { RslPolicy } from "../rsl.js";
import {
  normalizeBrowserReadinessPolicy,
  waitForBrowserReadiness,
  waitForTargetReadiness,
  type BrowserTargetReadinessRuntime,
  type NormalizedBrowserReadinessTarget,
  type NormalizedBrowserScrollInteraction,
} from "../runtime/readiness.js";

export function pageReadinessRuntime(page: Page): BrowserTargetReadinessRuntime {
  return {
    now: Date.now,
    sample: async () => page.evaluate(() => {
      const text = document.body?.innerText.trim() ?? "";
      let fingerprint = 2_166_136_261;
      for (let index = 0; index < text.length; index += 1) {
        fingerprint ^= text.charCodeAt(index);
        fingerprint = Math.imul(fingerprint, 16_777_619);
      }
      return {
        readyState: document.readyState,
        textCharacters: text.length,
        htmlCharacters: document.body?.innerHTML.length ?? 0,
        contentFingerprint: fingerprint >>> 0,
      };
    }),
    wait: async (milliseconds, signal) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(crawlCancelledError());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(crawlCancelledError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
    countTarget: async (target: NormalizedBrowserReadinessTarget) => {
      try {
        return await page.evaluate(({ selector, state }) => {
          const nodes = Array.from(document.querySelectorAll(selector));
          if (state === "attached") return nodes.length;
          return nodes.filter((node) => {
            const element = node as HTMLElement;
            const style = window.getComputedStyle(element);
            const rectangle = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" &&
              rectangle.width > 0 && rectangle.height > 0;
          }).length;
        }, target);
      } catch (error) {
        throw new ReadError(
          "INVALID_ARGUMENT",
          "browserReadiness.target.selector must be a valid CSS selector.",
          { details: { name: "browserReadiness.target.selector" }, cause: error },
        );
      }
    },
    performInteraction: async (_interaction: NormalizedBrowserScrollInteraction) => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    },
  };
}

function requestKey(url: URL): string {
  const normalized = new URL(url);
  normalized.hash = "";
  return normalized.toString();
}

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

function browserError(error: unknown, redactCause = false): ReadError {
  if (error instanceof ReadError) {
    return redactCause
      ? new ReadError(error.code, error.message, {
          retryable: error.retryable,
          details: error.details,
        })
      : error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return new ReadError("FETCH_TIMEOUT", "The browser timed out while loading the page.", {
      retryable: true,
      ...(redactCause ? {} : { cause: error }),
    });
  }
  if (/executable|browser.*not found|channel/i.test(message)) {
    return new ReadError("BROWSER_UNAVAILABLE", "A compatible local Chrome browser is unavailable.", {
      ...(redactCause ? {} : { cause: error }),
    });
  }
  return new ReadError("BROWSER_UNAVAILABLE", "The browser could not load the page.", {
    ...(redactCause ? {} : { cause: error }),
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

  async fetch(url: URL, options: PageFetchOptions = {}): Promise<RawPage> {
    const { authProfile, signal, browserReadiness } = options;
    const readinessPolicy = browserReadiness === undefined
      ? undefined
      : normalizeBrowserReadinessPolicy(browserReadiness);
    let context: BrowserContext | null = null;
    let lease: BrowserLease | null = null;
    let profilePath: string | null = null;
    let capAuthorizationUsed = false;
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
      robotsRsl = (await this.rsl.authorizeRobots(
        url,
        await this.robots.licenseUrls(url),
      )).evidence;

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
      const presentedAuthorizations = new Map<string, string>();
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
            const decision = await this.rsl.authorizeRobots(
              parsed,
              await this.robots.licenseUrls(parsed),
            );
            robotsRsl = decision.authorization === null
              ? decision.evidence
              : { ...decision.evidence, licenseTokensApplied: 1 };
            if (decision.authorization !== null) {
              capAuthorizationUsed = true;
              presentedAuthorizations.set(requestKey(parsed), decision.authorization);
              await route.continue({
                headers: { ...request.headers(), authorization: decision.authorization },
              });
              return;
            }
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

      const navigationStartedAt = Date.now();
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
      const readinessBudgetMs = this.config.browserTimeoutMs - (Date.now() - navigationStartedAt);
      if (readinessBudgetMs <= 0) {
        throw new ReadError(
          "FETCH_TIMEOUT",
          "The browser exhausted its time budget before readiness could be checked.",
          { retryable: true, details: { timeoutMs: this.config.browserTimeoutMs } },
        );
      }
      const readinessTimeoutMs = Math.min(
        readinessBudgetMs,
        readinessPolicy?.timeoutMs ?? readinessBudgetMs,
      );
      const runtime = pageReadinessRuntime(page);
      const readiness = readinessPolicy === undefined
        ? await waitForBrowserReadiness(runtime, {
            timeoutMs: readinessTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
          })
        : await waitForTargetReadiness(runtime, readinessPolicy, {
            timeoutMs: readinessTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
          });

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
      const presentedAuthorization = presentedAuthorizations.get(requestKey(finalParsed)) ?? null;
      const responseDecision = await this.rsl.authorizeResponse(finalParsed, {
        url: finalParsed,
        status: response.status(),
        contentType: responseHeaders["content-type"] ?? "text/html",
        body: policyBody,
        responseBytes,
        retryAfterMs: parseRetryAfterMs(responseHeaders["retry-after"] ?? null),
        proxyUsed: proxy !== null,
        agentIdentity: agentIdentityEvidence(this.config, false),
        linkHeader: responseHeaders.link ?? null,
      }, presentedAuthorization !== null, presentedAuthorization);
      if (
        responseDecision.authorization !== null &&
        responseDecision.authorization !== presentedAuthorization
      ) {
        throw new ReadError(
          "RSL_LICENSE_REQUIRED",
          "The browser response requires a License Token that was not declared before navigation.",
          { details: { url: finalParsed.toString() } },
        );
      }
      const responseRsl = responseDecision.evidence;
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
        browserReadiness: {
          policy: readinessPolicy === undefined ? "generic" : "target",
          waitedMs: readiness.waitedMs,
          reason: readiness.reason,
          textCharacters: readiness.textCharacters,
          ...("targetMatches" in readiness
            ? { targetMatches: readiness.targetMatches }
            : {}),
          ...(readinessPolicy?.interaction === undefined
            ? {}
            : { interaction: readinessPolicy.interaction.type }),
          ...("interactionSteps" in readiness
            ? { interactionSteps: readiness.interactionSteps }
            : {}),
        },
        proxyUsed: proxy !== null,
        agentIdentity: agentIdentityEvidence(this.config, false),
        rsl,
      };
    } catch (error) {
      throw browserError(error, capAuthorizationUsed);
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
