import type { LookupFunction } from "node:net";

import { Agent, fetch, ProxyAgent, type Dispatcher } from "undici";

import type { AppConfig } from "../config.js";
import { AgentIdentity } from "../identity.js";
import { errorForHttpStatus, parseRetryAfterMs, ReadError } from "../errors.js";
import type { PageFetchOptions, PageFetcher, RawPage } from "../types.js";
import { UrlPolicy } from "../security/url-policy.js";
import type { RobotsPolicy } from "../security/robots.js";
import { ProxyPool } from "../proxy.js";
import type { RslPolicy } from "../rsl.js";

export type TransportResponse = {
  url: URL;
  status: number;
  contentType: string;
  body: string;
  responseBytes: number;
  retryAfterMs: number | null;
  proxyUsed: boolean;
  agentIdentity: ReturnType<AgentIdentity["evidence"]>;
  linkHeader: string | null;
};

export type FormResponse = {
  status: number;
  contentType: string;
  body: string;
};

type BeforeRequest = (url: URL) => Promise<{ authorization: string } | void>;

function safeLookup(policy: UrlPolicy): LookupFunction {
  return (hostname, options, callback): void => {
    void policy
      .resolve(hostname)
      .then((addresses) => {
        const requestedFamily = options.family ?? 0;
        const allowed = addresses.filter(
          ({ address, family }) =>
            policy.isAllowedResolvedAddress(address) &&
            (requestedFamily === 0 || requestedFamily === family),
        );
        if (allowed.length === 0) {
          const error = new Error("DNS resolution returned no public addresses.") as NodeJS.ErrnoException;
          error.code = "EACCES";
          callback(error, [], 0);
          return;
        }
        if (options.all === true) {
          callback(null, allowed);
          return;
        }
        const first = allowed[0];
        if (first === undefined) {
          const error = new Error("DNS resolution returned no usable address.") as NodeJS.ErrnoException;
          error.code = "EAI_AGAIN";
          callback(error, [], 0);
          return;
        }
        callback(null, first.address, first.family);
      })
      .catch((cause: unknown) => {
        const error = new Error("Safe DNS lookup failed.", { cause }) as NodeJS.ErrnoException;
        error.code = "EACCES";
        callback(error, [], 0);
      });
  };
}

type StreamReader = {
  read(): Promise<{ done: boolean; value?: unknown }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
};

type ReadableBody = {
  getReader(): StreamReader;
};

async function readLimitedBody(
  body: ReadableBody | null,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  if (body === null) {
    return { text: "", bytes: 0 };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return { text, bytes };
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw new ReadError("UPSTREAM_ERROR", "The response stream returned an invalid chunk.");
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("response too large");
        throw new ReadError("RESPONSE_TOO_LARGE", "The response exceeded the configured size limit.", {
          details: { maxResponseBytes: maxBytes },
        });
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export class HttpTransport {
  private readonly directDispatcher: Agent;
  private readonly proxyDispatchers = new Map<string, ProxyAgent>();
  private readonly identity: AgentIdentity;

  constructor(
    private readonly config: AppConfig,
    private readonly urlPolicy: UrlPolicy,
    private readonly proxyPool = new ProxyPool(config.proxyEndpoints),
  ) {
    this.identity = new AgentIdentity(config);
    this.directDispatcher = new Agent({
      connect: { lookup: safeLookup(urlPolicy) },
      pipelining: 1,
      connections: 4,
    });
  }

  async fetch(
    initialUrl: URL,
    options: { maxBytes?: number; beforeRequest?: BeforeRequest } = {},
  ): Promise<TransportResponse> {
    let current = initialUrl;
    const maxBytes = options.maxBytes ?? this.config.maxResponseBytes;
    const proxy = this.proxyPool.acquire();
    const dispatcher = this.dispatcherFor(proxy?.uri ?? null);

    for (let redirects = 0; redirects <= this.config.maxRedirects; redirects += 1) {
      await this.urlPolicy.assertPublic(current);
      const access = await options.beforeRequest?.(current);

      let response;
      try {
        const headers = this.identity.headers(current, {
          "accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
          "accept-language": "en-US,en;q=0.8",
          ...(access === undefined ? {} : { "authorization": access.authorization }),
          "user-agent": this.config.userAgent,
        });
        response = await fetch(current, {
          dispatcher,
          redirect: "manual",
          headers,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (error) {
        if (error instanceof ReadError) {
          throw error;
        }
        const isTimeout =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        throw new ReadError(
          isTimeout ? "FETCH_TIMEOUT" : "UPSTREAM_ERROR",
          isTimeout ? "The page request timed out." : "The page request failed.",
          {
            retryable: true,
            details: { url: current.toString() },
            ...(access === undefined ? { cause: error } : {}),
          },
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null) {
          throw new ReadError("UPSTREAM_ERROR", "The site returned a redirect without a location.", {
            details: { httpStatus: response.status, url: current.toString() },
          });
        }
        if (redirects === this.config.maxRedirects) {
          throw new ReadError("UPSTREAM_ERROR", "The page exceeded the redirect limit.", {
            details: { maxRedirects: this.config.maxRedirects, url: current.toString() },
          });
        }
        current = this.urlPolicy.parse(new URL(location, current).toString());
        continue;
      }

      const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel();
        throw new ReadError("RESPONSE_TOO_LARGE", "The response exceeded the configured size limit.", {
          details: { contentLength, maxResponseBytes: maxBytes },
        });
      }
      const body = await readLimitedBody(response.body, maxBytes);
      return {
        url: current,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body: body.text,
        responseBytes: body.bytes,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        proxyUsed: proxy !== null,
        agentIdentity: this.identity.evidence(),
        linkHeader: response.headers.get("link"),
      };
    }

    throw new ReadError("UPSTREAM_ERROR", "The page exceeded the redirect limit.");
  }

  async postForm(
    url: URL,
    form: URLSearchParams,
    authorization: string,
    maxBytes: number,
  ): Promise<FormResponse> {
    if (url.protocol !== "https:") {
      throw new ReadError("UPSTREAM_ERROR", "Authenticated form requests require HTTPS.");
    }
    await this.urlPolicy.assertPublic(url);
    let response;
    try {
      response = await fetch(url, {
        dispatcher: this.directDispatcher,
        method: "POST",
        redirect: "manual",
        headers: {
          "accept": "application/json",
          "authorization": authorization,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": this.config.userAgent,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ReadError(
        isTimeout ? "FETCH_TIMEOUT" : "UPSTREAM_ERROR",
        isTimeout ? "The authenticated request timed out." : "The authenticated request failed.",
        { retryable: true },
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ReadError("UPSTREAM_ERROR", "The authenticated request returned a redirect.");
    }
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      throw new ReadError("RESPONSE_TOO_LARGE", "The authenticated response was too large.");
    }
    const body = await readLimitedBody(response.body, maxBytes);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: body.text,
    };
  }

  async close(): Promise<void> {
    await Promise.all([
      this.directDispatcher.close(),
      ...[...this.proxyDispatchers.values()].map(async (dispatcher) => dispatcher.close()),
    ]);
  }

  private dispatcherFor(proxyUri: string | null): Dispatcher {
    if (proxyUri === null) {
      return this.directDispatcher;
    }
    const existing = this.proxyDispatchers.get(proxyUri);
    if (existing !== undefined) {
      return existing;
    }
    const dispatcher = new ProxyAgent(proxyUri);
    this.proxyDispatchers.set(proxyUri, dispatcher);
    return dispatcher;
  }
}

export class HttpPageFetcher implements PageFetcher {
  constructor(
    private readonly transport: HttpTransport,
    private readonly robots: RobotsPolicy,
    private readonly rsl: RslPolicy,
  ) {}

  async fetch(url: URL, _options: PageFetchOptions = {}): Promise<RawPage> {
    let robotsRsl = this.rsl.emptyEvidence();
    let challenge: {
      url: string;
      authorization: string;
      evidence: ReturnType<RslPolicy["emptyEvidence"]>;
    } | null = null;

    for (let capAttempt = 0; capAttempt < 2; capAttempt += 1) {
      const presented = new Map<string, string>();
      const response = await this.transport.fetch(url, {
        beforeRequest: async (nextUrl) => {
          await this.robots.assertAllowed(nextUrl);
          const decision = await this.rsl.authorizeRobots(
            nextUrl,
            await this.robots.licenseUrls(nextUrl),
          );
          const nextUrlString = nextUrl.toString();
          const authorization =
            challenge !== null && challenge.url === nextUrlString
              ? challenge.authorization
              : decision.authorization;
          robotsRsl = authorization === decision.authorization && authorization !== null
            ? { ...decision.evidence, licenseTokensApplied: 1 }
            : decision.evidence;
          if (authorization !== null) {
            presented.set(nextUrlString, authorization);
            return { authorization };
          }
        },
      });
      const presentedAuthorization = presented.get(response.url.toString()) ?? null;
      const responseDecision = await this.rsl.authorizeResponse(
        response.url,
        response,
        presentedAuthorization !== null || response.status === 401 || response.status === 402,
        presentedAuthorization,
        presentedAuthorization !== null && (response.status === 401 || response.status === 402),
      );
      if (
        responseDecision.authorization !== null &&
        responseDecision.authorization !== presentedAuthorization
      ) {
        if (capAttempt === 1) {
          throw new ReadError(
            "RSL_LICENSE_REQUIRED",
            "The resource changed its License Token requirement after authorization.",
            { details: { url: response.url.toString() } },
          );
        }
        challenge = {
          url: response.url.toString(),
          authorization: responseDecision.authorization,
          evidence: responseDecision.evidence,
        };
        continue;
      }
      const challengeEvidence =
        challenge !== null &&
        challenge.url === response.url.toString() &&
        challenge.authorization === presentedAuthorization
          ? { ...challenge.evidence, licenseTokensApplied: 1 }
          : null;
      const responseRsl =
        responseDecision.evidence.status === "not-declared" && challengeEvidence !== null
          ? challengeEvidence
          : responseDecision.evidence;
      const rsl =
        responseRsl.status === "permitted" || robotsRsl.status === "not-declared"
          ? responseRsl
          : robotsRsl;
      const statusError = errorForHttpStatus(
        response.status,
        response.url.toString(),
        response.retryAfterMs,
      );
      if (statusError !== null) {
        throw statusError;
      }
      return {
        body: response.body,
        fetchedAt: new Date().toISOString(),
        method: "http",
        httpStatus: response.status,
        contentType: response.contentType,
        responseBytes: response.responseBytes,
        finalUrl: response.url.toString(),
        proxyUsed: response.proxyUsed,
        agentIdentity: response.agentIdentity,
        rsl,
      };
    }
    throw new ReadError("RSL_LICENSE_REQUIRED", "The CAP authorization attempt was exhausted.");
  }
}
