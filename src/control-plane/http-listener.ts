import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import type { AddressInfo } from "node:net";

import type { WorkerHttpApi, WorkerHttpRequest, WorkerHttpResponse } from "./organization-service.js";

// HTTP(S) transport for the control-plane API: bounded JSON bodies, query allow-list and listener lifecycle.

const workerBodyLimitBytes = 64 * 1024;
const workerHeaderLimitBytes = 16 * 1024;
const workerReceiveTimeoutMs = 10_000;
const controlPlaneQueryPath = /^(?:\/v1\/auth\/oidc\/callback|\/v1\/organizations|\/v1\/organizations\/[^/]+\/projects|\/v1\/projects\/[^/]+\/(?:api-keys|jobs\/[^/]+\/publications|audit-events|webhook-deliveries))$/u;

type WorkerTlsConfig = Readonly<{
  key: NonNullable<HttpsServerOptions["key"]>;
  cert: NonNullable<HttpsServerOptions["cert"]>;
  ca?: HttpsServerOptions["ca"];
}>;

export type WorkerControlServerConfig = Readonly<{
  host: string;
  port: number;
  tls: WorkerTlsConfig | null;
}>;

export type WorkerControlListener = Readonly<{
  origin: string;
  failure: Promise<never>;
  close(): Promise<void>;
}>;

class WorkerTransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkerTransportError";
  }
}

function validateWorkerListener(config: WorkerControlServerConfig): void {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new Error("Worker control server port must be an integer from 0 to 65535.");
  }
  if (config.host.trim() !== config.host || config.host.length === 0) {
    throw new Error("Worker control server host must be a non-empty exact address.");
  }
  if (config.tls === null && config.host !== "127.0.0.1" && config.host !== "::1") {
    throw new Error("Worker control server requires TLS outside an exact loopback address.");
  }
  if (config.tls !== null && (config.tls.key === undefined || config.tls.cert === undefined)) {
    throw new Error("Worker control server TLS requires a runtime key and certificate.");
  }
}

function distinctWorkerHeaders(request: IncomingMessage): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    if (values === undefined) continue;
    headers[name] = values.length === 1 ? values[0] : values;
  }
  return headers;
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) {
    throw new WorkerTransportError(400, "HEADER_DUPLICATED", `The ${name} header is duplicated.`);
  }
  return typeof value === "string" ? value : null;
}

function declaredBodyLength(headers: IncomingHttpHeaders): number | null {
  const value = singleHeader(headers, "content-length");
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new WorkerTransportError(400, "CONTENT_LENGTH_INVALID", "Content-Length is invalid.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new WorkerTransportError(413, "REQUEST_BODY_TOO_LARGE", "The request body is too large.");
  }
  return length;
}

function isJsonContent(headers: IncomingHttpHeaders): boolean {
  return singleHeader(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json";
}

async function readWorkerJson(
  request: IncomingMessage,
  headers: IncomingHttpHeaders,
): Promise<unknown> {
  const encoding = singleHeader(headers, "content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    throw new WorkerTransportError(
      415,
      "CONTENT_ENCODING_UNSUPPORTED",
      "Compressed control-plane request bodies are not accepted.",
    );
  }
  if ((declaredBodyLength(headers) ?? 0) > workerBodyLimitBytes) {
    request.resume();
    throw new WorkerTransportError(413, "REQUEST_BODY_TOO_LARGE", "The request body is too large.");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += bytes.byteLength;
    if (received > workerBodyLimitBytes) {
      request.resume();
      throw new WorkerTransportError(413, "REQUEST_BODY_TOO_LARGE", "The request body is too large.");
    }
    chunks.push(bytes);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new WorkerTransportError(400, "JSON_INVALID", "The request body is not valid UTF-8 JSON.", {
      cause: error,
    });
  }
}

function transportProblem(
  request: IncomingMessage,
  status: number,
  code: string,
  detail: string,
): WorkerHttpResponse {
  const requestId = crypto.randomUUID();
  const title = status === 413 ? "Payload Too Large"
    : status === 415 ? "Unsupported Media Type"
    : status === 500 ? "Internal Server Error"
    : "Bad Request";
  return {
    status,
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": requestId,
      ...(status === 413 ? { connection: "close" } : {}),
    },
    body: {
      type: `https://api.diaoyan.example/errors/${code.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      detail,
      instance: request.url ?? "",
      code,
      request_id: requestId,
      retryable: false,
    },
  };
}

function writeWorkerResponse(
  response: ServerResponse,
  result: WorkerHttpResponse,
  directTls: boolean,
): void {
  if (response.destroyed || response.writableEnded) return;
  const payload = result.body === null ? null : Buffer.from(JSON.stringify(result.body));
  response.writeHead(result.status, {
    ...result.headers,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(directTls ? { "strict-transport-security": "max-age=31536000" } : {}),
    ...(payload === null ? {} : { "content-length": String(payload.byteLength) }),
  });
  response.end(payload);
}

function workerRequestListener(
  api: Pick<WorkerHttpApi, "handle">,
  controllers: Set<AbortController>,
  directTls: boolean,
): RequestListener {
  return (request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    const close = () => {
      if (!response.writableEnded) abort();
    };
    request.once("aborted", abort);
    response.once("close", close);
    void (async () => {
      try {
        const headers = distinctWorkerHeaders(request);
        const requestTarget = request.url ?? "";
        if (!requestTarget.startsWith("/")) {
          throw new WorkerTransportError(400, "REQUEST_TARGET_INVALID", "The request target is invalid.");
        }
        const target = new URL(requestTarget, "http://worker.invalid");
        if (target.search !== "" && !controlPlaneQueryPath.test(target.pathname)) {
          throw new WorkerTransportError(400, "QUERY_UNSUPPORTED", "Control-plane API routes do not accept query parameters.");
        }
        if ((declaredBodyLength(headers) ?? 0) > workerBodyLimitBytes) {
          request.resume();
          throw new WorkerTransportError(413, "REQUEST_BODY_TOO_LARGE", "The request body is too large.");
        }
        const body = isJsonContent(headers) ? await readWorkerJson(request, headers) : null;
        if (!isJsonContent(headers)) request.resume();
        const result = await api.handle({
          method: request.method ?? "",
          path: target.pathname,
          query: target.search,
          headers,
          body,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) writeWorkerResponse(response, result, directTls);
      } catch (error) {
        if (controller.signal.aborted) return;
        request.resume();
        const result = error instanceof WorkerTransportError
          ? transportProblem(request, error.status, error.code, error.message)
          : transportProblem(request, 500, "INTERNAL_ERROR", "The control-plane request could not be read.");
        writeWorkerResponse(response, result, directTls);
      } finally {
        controllers.delete(controller);
        request.off("aborted", abort);
        response.off("close", close);
      }
    })();
  };
}

export async function startWorkerControlServer(
  api: Pick<WorkerHttpApi, "handle">,
  config: WorkerControlServerConfig,
): Promise<WorkerControlListener> {
  validateWorkerListener(config);
  const controllers = new Set<AbortController>();
  const listener = workerRequestListener(api, controllers, config.tls !== null);
  const server = config.tls === null
    ? createHttpServer({ maxHeaderSize: workerHeaderLimitBytes }, listener)
    : createHttpsServer({
      ...config.tls,
      minVersion: "TLSv1.2",
      honorCipherOrder: true,
      maxHeaderSize: workerHeaderLimitBytes,
    }, listener);
  server.maxHeadersCount = 32;
  server.headersTimeout = workerReceiveTimeoutMs;
  server.requestTimeout = workerReceiveTimeoutMs;
  server.keepAliveTimeout = 5_000;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => undefined);
  server.on("error", rejectFailure);
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const failed = (error: Error) => rejectListen(error);
    server.once("error", failed);
    server.listen(config.port, config.host, () => {
      server.off("error", failed);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return Object.freeze({
    origin: `${config.tls === null ? "http" : "https"}://${host}:${address.port}`,
    failure,
    close: async () => {
      for (const controller of controllers) controller.abort();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
        server.closeAllConnections();
      });
    },
  });
}
