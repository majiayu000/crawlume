import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import type { LookupAddress } from "node:dns";

import { ReadError } from "../errors.js";
import type { ProxyEndpoint } from "../proxy.js";
import type { UrlPolicy } from "./url-policy.js";

type RunningProxy = {
  endpoint: ProxyEndpoint;
  server: Server;
  sockets: Set<Duplex>;
};

type ApprovedTarget = {
  addresses: LookupAddress[];
  original: URL;
};

type PinnedTarget = {
  address: string;
  original: URL;
  pinned: URL;
};

const maximumProxyResponseHeaderBytes = 16 * 1024;
const proxyConnectTimeoutMs = 20_000;

function normalizedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function urlHostname(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

function authority(address: string, port: number): string {
  return `${urlHostname(address)}:${port}`;
}

function targetPort(url: URL): number {
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ReadError("INVALID_URL", "The target URL has an invalid port.");
  }
  return port;
}

function pinnedTarget(original: URL, address: string): PinnedTarget {
  const pinned = new URL(original);
  pinned.hostname = urlHostname(address);
  return { address, original, pinned };
}

function uniqueAddresses(addresses: LookupAddress[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const { address } of addresses) {
    if (seen.has(address)) continue;
    seen.add(address);
    unique.push(address);
  }
  return unique;
}

function proxyAuthorization(proxy: URL): string | null {
  if (proxy.username === "" && proxy.password === "") return null;
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function requestHeaders(
  headers: IncomingHttpHeaders,
  host: string,
  proxy: URL | null,
): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = { ...headers, host };
  delete outgoing["proxy-authorization"];
  delete outgoing["proxy-connection"];
  if (proxy !== null) {
    const authorization = proxyAuthorization(proxy);
    if (authorization !== null) outgoing["proxy-authorization"] = authorization;
  }
  return outgoing;
}

function requestUrl(request: IncomingMessage): URL {
  const raw = request.url ?? "";
  try {
    return new URL(raw);
  } catch {
    const host = request.headers.host;
    if (host === undefined) throw new ReadError("INVALID_URL", "The proxy request has no target host.");
    return new URL(raw, `http://${host}`);
  }
}

function writeProxyFailure(response: ServerResponse, error: unknown): void {
  const status = error instanceof ReadError &&
      (error.code === "SSRF_BLOCKED" || error.code === "INVALID_URL")
    ? 403
    : 502;
  if (!response.headersSent) {
    response.writeHead(status, {
      "connection": "close",
      "content-type": "text/plain; charset=utf-8",
    });
  }
  response.end(status === 403 ? "Target blocked by URL policy." : "Upstream connection failed.");
}

function writeTunnelFailure(socket: Duplex, error: unknown): void {
  const status = error instanceof ReadError &&
      (error.code === "SSRF_BLOCKED" || error.code === "INVALID_URL")
    ? "403 Forbidden"
    : "502 Bad Gateway";
  if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  else socket.destroy();
}

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
}

function abortError(): Error {
  return new DOMException("The client closed the proxy connection.", "AbortError");
}

function isPolicyError(error: unknown): boolean {
  return error instanceof ReadError &&
    (error.code === "SSRF_BLOCKED" || error.code === "INVALID_URL");
}

function isClientAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") return false;
    return true;
  }
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw abortError();
}

function bindClientAbort(client: Duplex, request?: IncomingMessage): {
  signal: AbortSignal;
  track: (socket: Socket) => void;
} {
  const controller = new AbortController();
  const tracked = new Set<Socket>();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(abortError());
    for (const socket of tracked) socket.destroy();
  };
  if (client.destroyed || request?.destroyed === true) abort();
  else {
    client.once("close", abort);
    client.once("error", abort);
    request?.once("aborted", abort);
  }
  return {
    signal: controller.signal,
    track: (socket) => {
      tracked.add(socket);
      socket.once("close", () => tracked.delete(socket));
    },
  };
}

function abortSignalFromHttp(request: IncomingMessage, response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(abortError());
  };
  if (request.destroyed) {
    abort();
    return controller.signal;
  }
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  return controller.signal;
}

function withTimeout(
  signal: AbortSignal,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The proxy connection timed out.", "TimeoutError"));
  }, ms);
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

async function waitForSocketEvent(
  socket: Socket,
  event: "connect" | "secureConnect",
  signal: AbortSignal,
): Promise<void> {
  const setup = withTimeout(signal, proxyConnectTimeoutMs);
  try {
    throwIfAborted(setup.signal);
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        socket.destroy();
        const reason = setup.signal.reason;
        reject(reason instanceof Error ? reason : abortError());
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onEvent = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        setup.signal.removeEventListener("abort", onAbort);
        socket.off("error", onError);
        socket.off(event, onEvent);
      };
      setup.signal.addEventListener("abort", onAbort);
      socket.once("error", onError);
      socket.once(event, onEvent);
    });
  } finally {
    setup.dispose();
  }
}

async function waitForOutboundConnect(
  outbound: ClientRequest,
  signal: AbortSignal,
): Promise<void> {
  const setup = withTimeout(signal, proxyConnectTimeoutMs);
  try {
    throwIfAborted(setup.signal);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error instanceof Error ? error : abortError());
      };
      const onAbort = (): void => {
        outbound.destroy();
        const reason = setup.signal.reason;
        finish(reason instanceof Error ? reason : abortError());
      };
      const onError = (error: Error): void => finish(error);
      const onSocket = (socket: Socket): void => {
        if (socket.destroyed) {
          finish(new Error("The upstream socket closed before connecting."));
          return;
        }
        if (!socket.connecting) {
          finish();
          return;
        }
        socket.once("connect", () => finish());
        socket.once("error", onError);
      };
      const cleanup = (): void => {
        setup.signal.removeEventListener("abort", onAbort);
        outbound.off("error", onError);
        outbound.off("socket", onSocket);
      };
      setup.signal.addEventListener("abort", onAbort);
      outbound.once("error", onError);
      outbound.once("socket", onSocket);
      if (outbound.socket != null) onSocket(outbound.socket);
    });
  } finally {
    setup.dispose();
  }
}

async function firstSuccessful<T>(
  addresses: string[],
  signal: AbortSignal,
  attempt: (address: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const address of addresses) {
    throwIfAborted(signal);
    try {
      return await attempt(address);
    } catch (error) {
      if (isPolicyError(error) || isClientAbort(error, signal)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("Upstream connection failed.");
}

export class PolicyEgressProxy {
  private readonly running = new Map<string, Promise<RunningProxy>>();

  constructor(private readonly policy: UrlPolicy) {}

  async endpoint(upstream: ProxyEndpoint | null): Promise<ProxyEndpoint> {
    const key = upstream?.uri ?? "direct";
    let running = this.running.get(key);
    if (running === undefined) {
      running = this.start(upstream).catch((error: unknown) => {
        if (this.running.get(key) === running) this.running.delete(key);
        throw error;
      });
      this.running.set(key, running);
    }
    return (await running).endpoint;
  }

  async close(): Promise<void> {
    const entries = [...this.running.values()];
    this.running.clear();
    const failures: unknown[] = [];
    for (const entry of entries) {
      try {
        const running = await entry;
        for (const socket of running.sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => {
          running.server.close((error) => error === undefined ? resolve() : reject(error));
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Multiple policy egress proxies failed to close.");
    }
  }

  private async approved(url: URL, signal: AbortSignal): Promise<ApprovedTarget> {
    throwIfAborted(signal);
    const original = this.policy.parse(url.toString());
    const addresses = await this.policy.assertPublic(original);
    throwIfAborted(signal);
    if (addresses.length === 0) {
      throw new ReadError("SSRF_BLOCKED", "The target resolved to no approved address.");
    }
    return { addresses, original };
  }

  private async start(upstream: ProxyEndpoint | null): Promise<RunningProxy> {
    const sockets = new Set<Duplex>();
    const upstreamUrl = upstream === null ? null : new URL(upstream.uri);
    const server = createServer((request, response) => {
      void this.forwardRequest(request, response, upstreamUrl, sockets)
        .catch((error: unknown) => writeProxyFailure(response, error));
    });
    server.on("connection", (socket) => trackSocket(sockets, socket));
    server.on("connect", (request, socket, head) => {
      void this.forwardTunnel(request, socket, head, upstreamUrl, sockets)
        .catch((error: unknown) => writeTunnelFailure(socket, error));
    });
    server.on("upgrade", (request, socket, head) => {
      trackSocket(sockets, socket);
      void this.forwardUpgrade(request, socket, head, upstreamUrl, sockets)
        .catch((error: unknown) => writeTunnelFailure(socket, error));
    });
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      server.close();
      throw new Error("The policy egress proxy did not bind a TCP port.");
    }
    const serverUrl = `http://127.0.0.1:${bound.port}`;
    return {
      server,
      sockets,
      endpoint: {
        uri: `${serverUrl}/`,
        browser: { server: serverUrl },
      },
    };
  }

  private async forwardRequest(
    request: IncomingMessage,
    response: ServerResponse,
    upstream: URL | null,
    sockets: Set<Duplex>,
  ): Promise<void> {
    const signal = abortSignalFromHttp(request, response);
    const target = await this.approved(requestUrl(request), signal);
    let lastError: unknown;
    for (const address of uniqueAddresses(target.addresses)) {
      throwIfAborted(signal);
      const outbound = this.outboundRequest(
        request,
        pinnedTarget(target.original, address),
        upstream,
      );
      trackSocketOnRequest(sockets, outbound);
      try {
        outbound.flushHeaders();
        await waitForOutboundConnect(outbound, signal);
      } catch (error) {
        outbound.destroy();
        if (isPolicyError(error) || isClientAbort(error, signal)) throw error;
        lastError = error;
        continue;
      }
      await this.pipeHttp(request, response, outbound);
      return;
    }
    throw lastError ?? new Error("Upstream connection failed.");
  }

  private pipeHttp(
    request: IncomingMessage,
    response: ServerResponse,
    outbound: ClientRequest,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      outbound.once("response", (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          upstreamResponse.headers,
        );
        upstreamResponse.once("error", (error) => response.destroy(error));
        upstreamResponse.pipe(response);
        resolve();
      });
      outbound.once("error", reject);
      request.once("aborted", () => outbound.destroy());
      response.once("close", () => {
        if (!response.writableEnded) outbound.destroy();
      });
      request.pipe(outbound);
    });
  }

  private outboundRequest(
    request: IncomingMessage,
    target: PinnedTarget,
    upstream: URL | null,
  ): ClientRequest {
    const direct = upstream === null;
    const connection = direct ? target.pinned : upstream;
    const protocol = connection.protocol;
    const path = direct
      ? `${target.original.pathname}${target.original.search}`
      : target.pinned.toString();
    const options: RequestOptions = {
      protocol,
      hostname: normalizedHostname(connection.hostname),
      port: targetPort(connection),
      method: request.method,
      path,
      headers: requestHeaders(request.headers, target.original.host, upstream),
      ...(protocol === "https:"
        ? {
          servername: direct
            ? normalizedHostname(target.original.hostname)
            : normalizedHostname(connection.hostname),
        }
        : {}),
    };
    return protocol === "https:" ? httpsRequest(options) : httpRequest(options);
  }

  private async forwardTunnel(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
    upstream: URL | null,
    sockets: Set<Duplex>,
  ): Promise<void> {
    const clientAbort = bindClientAbort(client, request);
    const signal = clientAbort.signal;
    const authorityUrl = new URL(`https://${request.url ?? ""}/`);
    const target = await this.approved(authorityUrl, signal);
    const port = targetPort(target.original);
    const connection = await firstSuccessful(
      uniqueAddresses(target.addresses),
      signal,
      async (address) =>
        upstream === null
          ? this.directSocket(address, port, sockets, signal, clientAbort.track)
          : this.upstreamTunnel(upstream, address, port, sockets, signal, clientAbort.track),
    );
    if (client.destroyed) {
      connection.socket.destroy();
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) connection.socket.write(head);
    if (connection.head.length > 0) client.write(connection.head);
    client.pipe(connection.socket);
    connection.socket.pipe(client);
  }

  private async directSocket(
    address: string,
    port: number,
    sockets: Set<Duplex>,
    signal: AbortSignal,
    trackOutbound: (socket: Socket) => void,
  ): Promise<{ socket: Socket; head: Buffer }> {
    throwIfAborted(signal);
    const socket = netConnect({ host: address, port });
    trackSocket(sockets, socket);
    trackOutbound(socket);
    await waitForSocketEvent(socket, "connect", signal);
    return { socket, head: Buffer.alloc(0) };
  }

  private async upstreamTunnel(
    upstream: URL,
    address: string,
    port: number,
    sockets: Set<Duplex>,
    signal: AbortSignal,
    trackOutbound: (socket: Socket) => void,
  ): Promise<{ socket: Socket; head: Buffer }> {
    throwIfAborted(signal);
    const socket = upstream.protocol === "https:"
      ? tlsConnect({
        host: normalizedHostname(upstream.hostname),
        port: targetPort(upstream),
        servername: normalizedHostname(upstream.hostname),
      })
      : netConnect({ host: normalizedHostname(upstream.hostname), port: targetPort(upstream) });
    trackSocket(sockets, socket);
    trackOutbound(socket);
    await waitForSocketEvent(
      socket,
      upstream.protocol === "https:" ? "secureConnect" : "connect",
      signal,
    );
    throwIfAborted(signal);
    const targetAuthority = authority(address, port);
    const authorization = proxyAuthorization(upstream);
    socket.write(
      `CONNECT ${targetAuthority} HTTP/1.1\r\n` +
      `Host: ${targetAuthority}\r\n` +
      (authorization === null ? "" : `Proxy-Authorization: ${authorization}\r\n`) +
      "Proxy-Connection: keep-alive\r\n\r\n",
    );
    const response = await readProxyConnectResponse(socket, signal);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      socket.destroy();
      throw new Error(`The configured proxy rejected the tunnel with HTTP ${response.statusCode}.`);
    }
    return { socket, head: response.head };
  }

  private async forwardUpgrade(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
    upstream: URL | null,
    sockets: Set<Duplex>,
  ): Promise<void> {
    const clientAbort = bindClientAbort(client, request);
    const signal = clientAbort.signal;
    const raw = requestUrl(request);
    if (raw.protocol === "ws:") raw.protocol = "http:";
    if (raw.protocol === "wss:") raw.protocol = "https:";
    const target = await this.approved(raw, signal);
    const outbound = await firstSuccessful(
      uniqueAddresses(target.addresses),
      signal,
      async (address) => {
        const requestOutbound = this.outboundRequest(
          request,
          pinnedTarget(target.original, address),
          upstream,
        );
        trackSocketOnRequest(sockets, requestOutbound);
        requestOutbound.once("socket", (socket) => clientAbort.track(socket));
        requestOutbound.flushHeaders();
        try {
          await waitForOutboundConnect(requestOutbound, signal);
        } catch (error) {
          requestOutbound.destroy();
          throw error;
        }
        return requestOutbound;
      },
    );
    outbound.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      trackSocket(sockets, upstreamSocket);
      const statusLine = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
      const headers = rawHeaderBlock(upstreamResponse.rawHeaders);
      client.write(`${statusLine}${headers}\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
      if (upstreamHead.length > 0) client.write(upstreamHead);
      client.pipe(upstreamSocket);
      upstreamSocket.pipe(client);
    });
    outbound.once("response", (upstreamResponse) => {
      client.end(
        `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode ?? 502} ` +
        `${upstreamResponse.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`,
      );
      upstreamResponse.resume();
    });
    outbound.once("error", (error) => writeTunnelFailure(client, error));
    outbound.end();
  }
}

function trackSocketOnRequest(sockets: Set<Duplex>, request: ClientRequest): void {
  request.once("socket", (socket) => trackSocket(sockets, socket));
}

function rawHeaderBlock(headers: string[]): string {
  let block = "";
  for (let index = 0; index < headers.length; index += 2) {
    block += `${headers[index] ?? ""}: ${headers[index + 1] ?? ""}\r\n`;
  }
  return block;
}

async function readProxyConnectResponse(
  socket: Socket,
  signal: AbortSignal,
): Promise<{
  statusCode: number;
  head: Buffer;
}> {
  const setup = withTimeout(signal, proxyConnectTimeoutMs);
  try {
    throwIfAborted(setup.signal);
    return await new Promise((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      const onAbort = (): void => {
        cleanup();
        socket.destroy();
        const reason = setup.signal.reason;
        reject(reason instanceof Error ? reason : abortError());
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > maximumProxyResponseHeaderBytes) {
          cleanup();
          reject(new Error("The configured proxy returned oversized response headers."));
          return;
        }
        const boundary = buffered.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const header = buffered.subarray(0, boundary).toString("latin1");
        const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(header);
        cleanup();
        if (match?.[1] === undefined) {
          reject(new Error("The configured proxy returned an invalid CONNECT response."));
          return;
        }
        resolve({
          statusCode: Number(match[1]),
          head: buffered.subarray(boundary + 4),
        });
      };
      const cleanup = (): void => {
        setup.signal.removeEventListener("abort", onAbort);
        socket.off("error", onError);
        socket.off("data", onData);
      };
      setup.signal.addEventListener("abort", onAbort);
      socket.on("error", onError);
      socket.on("data", onData);
    });
  } finally {
    setup.dispose();
  }
}
