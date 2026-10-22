import {
  chromium,
  type BrowserContext,
  type LaunchOptions,
  type Page,
  type Response as BrowserResponse,
} from "playwright-core";

import {
  BrowserFailureTraceStore,
  type BrowserDomNodeTrace,
  type BrowserTracePhase,
} from "../browser-trace.js";
import type { AppConfig } from "../config.js";
import { AgentIdentity } from "../identity.js";
import { addTransferBytes, runWithTransferMeter } from "../transfer-meter.js";
import {
  crawlCancelledError,
  errorForHttpStatus,
  parseRetryAfterMs,
  ReadError,
} from "../errors.js";
import type { PageFetchOptions, PageFetcher, RawPage } from "../types.js";
import type { UrlRedirect } from "../types.js";
import { ProfileManager } from "../profiles.js";
import { UrlPolicy } from "../security/url-policy.js";
import { PolicyEgressProxy } from "../security/policy-egress-proxy.js";
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

async function browserRedirects(response: BrowserResponse): Promise<UrlRedirect[]> {
  const edges: UrlRedirect[] = [];
  let request = response.request();
  while (request.redirectedFrom() !== null) {
    const previous = request.redirectedFrom();
    if (previous === null) break;
    const previousResponse = await previous.response();
    edges.unshift({
      fromUrl: previous.url(),
      toUrl: request.url(),
      httpStatus: previousResponse?.status() ?? null,
    });
    request = previous;
  }
  return edges;
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
          ...(error.traceRef === null ? {} : { traceRef: error.traceRef }),
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
  if (/target.*closed|browser.*closed|disconnected|crash/iu.test(message)) {
    return new ReadError("BROWSER_UNAVAILABLE", "The local Chrome browser disconnected.", {
      retryable: true,
      ...(redactCause ? {} : { cause: error }),
    });
  }
  return new ReadError("BROWSER_UNAVAILABLE", "The browser could not load the page.", {
    ...(redactCause ? {} : { cause: error }),
  });
}

function incrementCounter(counters: Record<string, number>, key: string): void {
  counters[key] = Math.min(100_000, (counters[key] ?? 0) + 1);
}

function resourceTypeBucket(value: string): string {
  return [
    "document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch", "websocket",
  ].includes(value) ? value : "other";
}

function statusBucket(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function consoleBucket(value: string): string {
  return ["debug", "log", "info", "warning", "error"].includes(value) ? value : "other";
}

async function structuralDomSnapshot(page: Page): Promise<BrowserDomNodeTrace[]> {
  return page.locator("body, body *").evaluateAll((elements, maximumNodes) =>
    elements.slice(0, maximumNodes).map((element) => ({
      tag: element.tagName.toLowerCase(),
      childElements: element.children.length,
      textCharacters: element.textContent?.length ?? 0,
    })), 256);
}

export class BrowserPageFetcher implements PageFetcher {
  private readonly activeProfiles = new Set<string>();
  private readonly persistentContexts = new Set<Promise<BrowserContext>>();
  private readonly activeFetches = new Set<Promise<unknown>>();
  private closing = false;

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
    private readonly traceStore = new BrowserFailureTraceStore(config.dataDir),
    private readonly policyProxy = new PolicyEgressProxy(urlPolicy),
    private readonly identity = new AgentIdentity(config),
  ) {}

  async fetch(url: URL, options: PageFetchOptions = {}): Promise<RawPage> {
    if (this.closing) throw new ReadError("BROWSER_UNAVAILABLE", "The browser fetcher is closed.");
    const pending = runWithTransferMeter(() => this.fetchUnmetered(url, options));
    this.activeFetches.add(pending);
    try {
      const { result, bytes } = await pending;
      return { ...result, networkBytesIn: bytes };
    } finally {
      this.activeFetches.delete(pending);
    }
  }

  private async fetchUnmetered(url: URL, options: PageFetchOptions = {}): Promise<RawPage> {
    const { authProfile, signal, browserReadiness } = options;
    const notifyNetworkRequestStart = (): void => {
      try {
        options.onNetworkRequestStart?.();
      } catch (cause) {
        throw cause instanceof ReadError
          ? cause
          : new ReadError(
              "INTERNAL_ERROR",
              "The network request start callback failed.",
              { cause },
            );
      }
    };
    const allowedOrigins = authProfile === undefined
      ? null
      : new Set(options.allowedOrigins ?? [url.origin]);
    const maxResponseBytes = Math.min(
      options.maxResponseBytes ?? this.config.maxResponseBytes,
      this.config.maxResponseBytes,
    );
    const timeoutMs = Math.min(options.timeoutMs ?? this.config.browserTimeoutMs, this.config.browserTimeoutMs);
    const readinessPolicy = browserReadiness === undefined
      ? undefined
      : normalizeBrowserReadinessPolicy(browserReadiness);
    let context: BrowserContext | null = null;
    let persistentLaunch: Promise<BrowserContext> | null = null;
    let lease: BrowserLease | null = null;
    let leaseHealthy = true;
    let page: Page | null = null;
    let profilePath: string | null = null;
    let capAuthorizationUsed = false;
    let onAbort: (() => void) | null = null;
    const proxy = this.proxyPool.acquire(authProfile);
    let robotsRsl = this.rsl.emptyEvidence();
    const traceStartedAt = Date.now();
    let tracePhase: BrowserTracePhase = "policy";
    let observedEvents = 0;
    let failedRequests = 0;
    const resourceTypes: Record<string, number> = {};
    const statusClasses: Record<string, number> = {};
    const consoleCounts: Record<string, number> = {};

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
      if (this.closing) throw new ReadError("BROWSER_UNAVAILABLE", "The browser fetcher is closed.");
      const browserProxy = await this.policyProxy.endpoint(proxy);
      if (this.closing) throw new ReadError("BROWSER_UNAVAILABLE", "The browser fetcher is closed.");

      tracePhase = "context";
      if (profilePath !== null) {
        persistentLaunch = chromium.launchPersistentContext(profilePath, {
          ...browserLaunchOptions(this.config, true, browserProxy),
          timeout: this.config.browserTimeoutMs,
          acceptDownloads: false,
          userAgent: this.config.userAgent,
        });
        this.persistentContexts.add(persistentLaunch);
        context = await persistentLaunch;
        if (this.closing) {
          throw new ReadError("BROWSER_UNAVAILABLE", "The browser fetcher closed during launch.");
        }
      } else {
        lease = await this.browserPool.acquire(browserProxy, signal);
        context = await lease.browser.newContext({
          acceptDownloads: false,
          userAgent: this.config.userAgent,
        });
      }

      if (signal?.aborted === true) {
        throw new ReadError("CRAWL_CANCELLED", "The crawl job was cancelled.");
      }
      onAbort = () => {
        void context?.close();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const activePage = context.pages()[0] ?? (await context.newPage());
      page = activePage;
      activePage.on("request", (request) => {
        observedEvents = Math.min(100_000, observedEvents + 1);
        incrementCounter(resourceTypes, resourceTypeBucket(request.resourceType()));
      });
      activePage.on("requestfailed", () => {
        failedRequests = Math.min(100_000, failedRequests + 1);
      });
      activePage.on("response", (networkResponse) => {
        incrementCounter(statusClasses, statusBucket(networkResponse.status()));
        const request = networkResponse.request();
        const isMain = request.isNavigationRequest() && request.frame() === activePage.mainFrame();
        if (isMain) {
          return;
        }
        const declaredLength = Number.parseInt(networkResponse.headers()["content-length"] ?? "", 10);
        addTransferBytes(Number.isFinite(declaredLength) ? declaredLength : 0);
      });
      activePage.on("console", (message) => {
        incrementCounter(consoleCounts, consoleBucket(message.type()));
      });
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
          const isMainNavigation = request.isNavigationRequest() && request.frame() === activePage.mainFrame();
          let authorization: string | null = null;
          if (isMainNavigation) {
            if (allowedOrigins !== null && !allowedOrigins.has(parsed.origin)) {
              throw new ReadError(
                "ACCESS_DENIED",
                "The authorized browser profile cannot navigate outside its allowed origins.",
                {
                  details: {
                    origin: parsed.origin,
                  },
                },
              );
            }
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
              authorization = decision.authorization;
            }
          }
          if (allowedOrigins !== null && isMainNavigation) {
            notifyNetworkRequestStart();
            let intercepted;
            try {
              intercepted = await route.fetch({
                maxRedirects: 0,
                timeout: timeoutMs,
                ...(signal === undefined ? {} : { signal }),
                headers: this.identity.headers(parsed, {
                  ...request.headers(),
                  ...(authorization === null ? {} : { authorization }),
                }),
              });
            } catch (error) {
              throw new ReadError("UPSTREAM_ERROR", "The authorized browser request failed.", {
                retryable: true,
                cause: error,
              });
            }
            const location = intercepted.headers()["location"];
            if (
              location !== undefined &&
              [301, 302, 303, 307, 308].includes(intercepted.status())
            ) {
              const redirect = this.urlPolicy.parse(new URL(location, parsed).toString());
              await this.urlPolicy.assertPublic(redirect);
              if (!allowedOrigins.has(redirect.origin)) {
                throw new ReadError(
                  "ACCESS_DENIED",
                  "The authorized browser profile cannot follow a redirect outside its allowed origins.",
                  {
                    details: {
                      origin: redirect.origin,
                    },
                  },
                );
              }
            }
            await route.fulfill({ response: intercepted });
            return;
          }
          if (isMainNavigation) {
            notifyNetworkRequestStart();
            await route.continue({
              headers: this.identity.headers(parsed, {
                ...request.headers(),
                ...(authorization === null ? {} : { authorization }),
              }),
            });
            return;
          }
          await route.continue();
        } catch (error) {
          if (request.isNavigationRequest() && request.frame() === activePage.mainFrame()) {
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
      tracePhase = "navigation";
      try {
        response = await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
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
      const readinessBudgetMs = timeoutMs - (Date.now() - navigationStartedAt);
      if (readinessBudgetMs <= 0) {
        throw new ReadError(
          "FETCH_TIMEOUT",
          "The browser exhausted its time budget before readiness could be checked.",
          { retryable: true, details: { timeoutMs } },
        );
      }
      const readinessTimeoutMs = Math.min(
        readinessBudgetMs,
        readinessPolicy?.timeoutMs ?? readinessBudgetMs,
      );
      tracePhase = "readiness";
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

      tracePhase = "response";
      const finalUrl = page.url();
      const redirects = await browserRedirects(response);
      const finalParsed = this.urlPolicy.parse(finalUrl);
      await this.urlPolicy.assertPublic(finalParsed);
      const body = await page.content();
      const responseBytes = Buffer.byteLength(body);
      if (responseBytes > maxResponseBytes) {
        throw new ReadError("RESPONSE_TOO_LARGE", "The rendered page exceeded the size limit.", {
          details: {
            maxResponseBytes,
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
        if (originalBody.byteLength > maxResponseBytes) {
          throw new ReadError("RESPONSE_TOO_LARGE", "The RSL response exceeded the size limit.", {
            details: {
              maxResponseBytes,
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
        agentIdentity: this.identity.evidence(),
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
      addTransferBytes(responseBytes);

      return {
        body,
        fetchedAt: new Date().toISOString(),
        method: "browser",
        httpStatus: response.status(),
        contentType: response.headers()["content-type"] ?? "text/html",
        responseBytes,
        finalUrl,
        redirects,
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
        agentIdentity: this.identity.evidence(),
        rsl,
      };
    } catch (error) {
      const failure = browserError(error, capAuthorizationUsed);
      leaseHealthy = failure.code !== "BROWSER_UNAVAILABLE";
      const authorized = authProfile !== undefined || capAuthorizationUsed;
      let dom: BrowserDomNodeTrace[] | null = null;
      let domCapture: "captured" | "omitted_authorized" | "unavailable" = authorized
        ? "omitted_authorized"
        : "unavailable";
      if (!authorized && page !== null) {
        try {
          dom = await structuralDomSnapshot(page);
          domCapture = "captured";
        } catch {
          domCapture = "unavailable";
        }
      }
      const traceRef = this.traceStore.record({
        authorized,
        phase: tracePhase,
        errorCode: failure.code,
        elapsedMs: Date.now() - traceStartedAt,
        dom,
        domCapture,
        network: { observedEvents, failedRequests, resourceTypes, statusClasses },
        console: consoleCounts,
      });
      throw new ReadError(failure.code, failure.message, {
        retryable: failure.retryable,
        details: failure.details,
        ...(failure.execution === null ? {} : { execution: failure.execution }),
        traceRef,
        cause: failure,
      });
    } finally {
      if (onAbort !== null) signal?.removeEventListener("abort", onAbort);
      await context?.close().catch(() => undefined);
      if (persistentLaunch !== null) this.persistentContexts.delete(persistentLaunch);
      await lease?.release(leaseHealthy);
      if (authProfile !== undefined) {
        this.activeProfiles.delete(authProfile);
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([
      ...[...this.persistentContexts].map(async (launch) => {
        // A failed launch has no context to close; its fetch retains the original error.
        const context = await launch.catch(() => null);
        await context?.close();
      }),
      this.browserPool.close(),
      this.policyProxy.close(),
    ]);
    await Promise.allSettled([...this.activeFetches]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "The browser resources failed to close.");
    }
  }
}
