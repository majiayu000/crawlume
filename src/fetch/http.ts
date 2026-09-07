import type { LookupFunction } from "node:net";

import { Agent, fetch, ProxyAgent, type Dispatcher } from "undici";

import type { AppConfig } from "../config.js";
import { AgentIdentity } from "../identity.js";
import { errorForHttpStatus, parseRetryAfterMs, ReadError } from "../errors.js";
import type { PageFetchOptions, PageFetcher, RawPage } from "../types.js";
import { UrlPolicy } from "../security/url-policy.js";
import type { RobotsPolicy } from "../security/robots.js";
import { ProxyPool, type ProxyEndpoint } from "../proxy.js";
import { PolicyEgressProxy } from "../security/policy-egress-proxy.js";
import type { RslPolicy } from "../rsl.js";

export type TransportResponse = {
  url: URL;
  status: number;
  contentType: string;
  body: string;
  bodyBytes?: Uint8Array;
  responseBytes: number;
  retryAfterMs: number | null;
  proxyUsed: boolean;
  agentIdentity: ReturnType<AgentIdentity["evidence"]>;
  linkHeader: string | null;
  redirects?: Array<{ fromUrl: string; toUrl: string; httpStatus: number }>;
  etag?: string;
  lastModified?: string;
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
): Promise<{ text: string; bytes: number; data: Uint8Array }> {
  if (body === null) {
    return { text: "", bytes: 0, data: new Uint8Array() };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const value of chunks) {
          data.set(value, offset);
          offset += value.byteLength;
        }
        return { text, bytes, data };
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
      chunks.push(chunk.value.slice());
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function transportFetchError(error: unknown, url: URL, includeCause: boolean): ReadError {
  if (error instanceof ReadError) return error;
  const isTimeout = error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
  return new ReadError(
    isTimeout ? "FETCH_TIMEOUT" : "UPSTREAM_ERROR",
    isTimeout ? "The page request timed out." : "The page request failed.",
    {
      retryable: true,
      details: { url: url.toString() },
      ...(includeCause ? { cause: error } : {}),
    },
  );
}

export class HttpTransport {
  private readonly directDispatcher: Agent;
  private readonly proxyDispatchers = new Map<string, Promise<ProxyAgent>>();
  private readonly identity: AgentIdentity;

  constructor(
    private readonly config: AppConfig,
    private readonly urlPolicy: UrlPolicy,
    private readonly proxyPool = new ProxyPool(config.proxyEndpoints),
    private readonly policyProxy = new PolicyEgressProxy(urlPolicy),
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
    options: {
      maxBytes?: number;
      signal?: AbortSignal;
      beforeRequest?: BeforeRequest;
      revalidate?: PageFetchOptions["revalidate"];
    } = {},
  ): Promise<TransportResponse> {
    let current = initialUrl;
    const redirectChain: NonNullable<TransportResponse["redirects"]> = [];
    const maxBytes = Math.min(options.maxBytes ?? this.config.maxResponseBytes, this.config.maxResponseBytes);
    const proxy = this.proxyPool.acquire();
    const dispatcher = await this.dispatcherFor(proxy);

    for (let redirectCount = 0; redirectCount <= this.config.maxRedirects; redirectCount += 1) {
      await this.urlPolicy.assertPublic(current);
      const access = await options.beforeRequest?.(current);

      let response;
      try {
        const headers = this.identity.headers(current, {
          "accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
          "accept-language": "en-US,en;q=0.8",
          ...(access === undefined ? {} : { "authorization": access.authorization }),
          ...(options.revalidate?.url === current.toString() && options.revalidate.etag !== undefined
            ? { "if-none-match": options.revalidate.etag }
            : {}),
          ...(options.revalidate?.url === current.toString() &&
          options.revalidate.lastModified !== undefined
            ? { "if-modified-since": options.revalidate.lastModified }
            : {}),
          "user-agent": this.config.userAgent,
        });
        const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs);
        response = await fetch(current, {
          dispatcher,
          redirect: "manual",
          headers,
          signal: options.signal === undefined
            ? timeoutSignal
            : AbortSignal.any([options.signal, timeoutSignal]),
        });
      } catch (error) {
        throw transportFetchError(error, current, access === undefined);
      }

      if (response.status !== 304 && response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null) {
          throw new ReadError("UPSTREAM_ERROR", "The site returned a redirect without a location.", {
            details: { httpStatus: response.status, url: current.toString() },
          });
        }
        if (redirectCount === this.config.maxRedirects) {
          throw new ReadError("UPSTREAM_ERROR", "The page exceeded the redirect limit.", {
            details: { maxRedirects: this.config.maxRedirects, url: current.toString() },
          });
        }
        const next = this.urlPolicy.parse(new URL(location, current).toString());
        redirectChain.push({
          fromUrl: current.toString(),
          toUrl: next.toString(),
          httpStatus: response.status,
        });
        current = next;
        continue;
      }

      const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel();
        throw new ReadError("RESPONSE_TOO_LARGE", "The response exceeded the configured size limit.", {
          details: { contentLength, maxResponseBytes: maxBytes },
        });
      }
      let body;
      try {
        body = await readLimitedBody(response.body, maxBytes);
      } catch (error) {
        throw transportFetchError(error, current, access === undefined);
      }
      return {
        url: current,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body: body.text,
        bodyBytes: body.data,
        responseBytes: body.bytes,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        proxyUsed: proxy !== null,
        agentIdentity: this.identity.evidence(),
        linkHeader: response.headers.get("link"),
        redirects: redirectChain,
        ...(response.headers.get("etag") === null
          ? {}
          : { etag: response.headers.get("etag") as string }),
        ...(response.headers.get("last-modified") === null
          ? {}
          : { lastModified: response.headers.get("last-modified") as string }),
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
    const proxyAgents = await Promise.all(
      [...this.proxyDispatchers.values()].map(async (dispatcher) => {
        try {
          return await dispatcher;
        } catch {
          return null;
        }
      }),
    );
    this.proxyDispatchers.clear();
    await Promise.all([
      this.directDispatcher.close(),
      ...proxyAgents.flatMap((dispatcher) => dispatcher === null ? [] : [dispatcher.close()]),
      this.policyProxy.close(),
    ]);
  }

  private async dispatcherFor(proxy: ProxyEndpoint | null): Promise<Dispatcher> {
    if (proxy === null) {
      return this.directDispatcher;
    }
    const existing = this.proxyDispatchers.get(proxy.uri);
    if (existing !== undefined) {
      return existing;
    }
    const created = this.createProxyDispatcher(proxy);
    this.proxyDispatchers.set(proxy.uri, created);
    created.catch(() => {
      if (this.proxyDispatchers.get(proxy.uri) === created) {
        this.proxyDispatchers.delete(proxy.uri);
      }
    });
    return created;
  }

  private async createProxyDispatcher(proxy: ProxyEndpoint): Promise<ProxyAgent> {
    const endpoint = await this.policyProxy.endpoint(proxy);
    return new ProxyAgent(endpoint.uri);
  }
}

export class HttpPageFetcher implements PageFetcher {
  constructor(
    private readonly transport: HttpTransport,
    private readonly robots: RobotsPolicy,
    private readonly rsl: RslPolicy,
  ) {}

  async fetch(url: URL, options: PageFetchOptions = {}): Promise<RawPage> {
    let robotsRsl = this.rsl.emptyEvidence();
    let challenge: {
      url: string;
      authorization: string;
      evidence: ReturnType<RslPolicy["emptyEvidence"]>;
    } | null = null;

    for (let capAttempt = 0; capAttempt < 2; capAttempt += 1) {
      const presented = new Map<string, string>();
      const response = await this.transport.fetch(url, {
        ...(options.maxResponseBytes === undefined
          ? {}
          : { maxBytes: options.maxResponseBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
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
        ...(response.bodyBytes === undefined ? {} : { bodyBytes: response.bodyBytes }),
        fetchedAt: new Date().toISOString(),
        method: "http",
        httpStatus: response.status,
        contentType: response.contentType,
        responseBytes: response.responseBytes,
        finalUrl: response.url.toString(),
        redirects: response.redirects ?? [],
        proxyUsed: response.proxyUsed,
        agentIdentity: response.agentIdentity,
        rsl,
        ...(response.etag === undefined ? {} : { etag: response.etag }),
        ...(response.lastModified === undefined ? {} : { lastModified: response.lastModified }),
        ...(response.status === 304 ? { notModified: true } : {}),
      };
    }
    throw new ReadError("RSL_LICENSE_REQUIRED", "The CAP authorization attempt was exhausted.");
  }
}
