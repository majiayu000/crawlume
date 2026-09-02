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

import { ReadError } from "../errors.js";
import type { ProxyEndpoint } from "../proxy.js";
import type { UrlPolicy } from "./url-policy.js";

type RunningProxy = {
  endpoint: ProxyEndpoint;
  server: Server;
  sockets: Set<Duplex>;
};

type ApprovedTarget = {
  address: string;
  original: URL;
  pinned: URL;
};

const maximumProxyResponseHeaderBytes = 16 * 1024;

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

export class PolicyEgressProxy {
  private readonly running = new Map<string, Promise<RunningProxy>>();

  constructor(private readonly policy: UrlPolicy) {}

  async endpoint(upstream: ProxyEndpoint | null): Promise<ProxyEndpoint> {
    const key = upstream?.uri ?? "direct";
    let running = this.running.get(key);
    if (running === undefined) {
      running = this.start(upstream);
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

  private async approved(url: URL): Promise<ApprovedTarget> {
    const original = this.policy.parse(url.toString());
    const addresses = await this.policy.assertPublic(original);
    const selected = addresses[0];
    if (selected === undefined) {
      throw new ReadError("SSRF_BLOCKED", "The target resolved to no approved address.");
    }
    const pinned = new URL(original);
    pinned.hostname = urlHostname(selected.address);
    return { address: selected.address, original, pinned };
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
    const target = await this.approved(requestUrl(request));
    const outbound = this.outboundRequest(request, target, upstream);
    trackSocketOnRequest(sockets, outbound);
    outbound.once("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      );
      upstreamResponse.once("error", (error) => response.destroy(error));
      upstreamResponse.pipe(response);
    });
    outbound.once("error", (error) => writeProxyFailure(response, error));
    request.once("aborted", () => outbound.destroy());
    response.once("close", () => {
      if (!response.writableEnded) outbound.destroy();
    });
    request.pipe(outbound);
  }

  private outboundRequest(
    request: IncomingMessage,
    target: ApprovedTarget,
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
    const authorityUrl = new URL(`https://${request.url ?? ""}/`);
    const target = await this.approved(authorityUrl);
    const port = targetPort(target.original);
    const connection = upstream === null
      ? await this.directSocket(target.address, port)
      : await this.upstreamTunnel(upstream, target.address, port);
    trackSocket(sockets, connection.socket);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) connection.socket.write(head);
    if (connection.head.length > 0) client.write(connection.head);
    client.pipe(connection.socket);
    connection.socket.pipe(client);
  }

  private async directSocket(
    address: string,
    port: number,
  ): Promise<{ socket: Socket; head: Buffer }> {
    const socket = netConnect({ host: address, port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return { socket, head: Buffer.alloc(0) };
  }

  private async upstreamTunnel(
    upstream: URL,
    address: string,
    port: number,
  ): Promise<{ socket: Socket; head: Buffer }> {
    const socket = upstream.protocol === "https:"
      ? tlsConnect({
        host: normalizedHostname(upstream.hostname),
        port: targetPort(upstream),
        servername: normalizedHostname(upstream.hostname),
      })
      : netConnect({ host: normalizedHostname(upstream.hostname), port: targetPort(upstream) });
    await new Promise<void>((resolve, reject) => {
      socket.once(upstream.protocol === "https:" ? "secureConnect" : "connect", resolve);
      socket.once("error", reject);
    });
    const targetAuthority = authority(address, port);
    const authorization = proxyAuthorization(upstream);
    socket.write(
      `CONNECT ${targetAuthority} HTTP/1.1\r\n` +
      `Host: ${targetAuthority}\r\n` +
      (authorization === null ? "" : `Proxy-Authorization: ${authorization}\r\n`) +
      "Proxy-Connection: keep-alive\r\n\r\n",
    );
    const response = await readProxyConnectResponse(socket);
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
    const raw = requestUrl(request);
    if (raw.protocol === "ws:") raw.protocol = "http:";
    if (raw.protocol === "wss:") raw.protocol = "https:";
    const target = await this.approved(raw);
    const outbound = this.outboundRequest(request, target, upstream);
    trackSocketOnRequest(sockets, outbound);
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

async function readProxyConnectResponse(socket: Socket): Promise<{
  statusCode: number;
  head: Buffer;
}> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
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
      socket.off("error", onError);
      socket.off("data", onData);
    };
    socket.on("error", onError);
    socket.on("data", onData);
  });
}
