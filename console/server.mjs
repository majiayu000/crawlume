// Serves the Crawlume console and reverse-proxies /v1/* to the control plane, so the OIDC state and
// refresh cookies the control plane sets stay on the console's origin. Run: node console/server.mjs
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
};
// Request headers that describe this hop rather than the request itself.
const hopHeaders = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection",
  "content-length", "accept-encoding",
]);
const bodyLimitBytes = 64 * 1024;

async function readBody(request) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.byteLength;
    if (received > bodyLimitBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxy(request, response, controlUrl) {
  const body = await readBody(request);
  if (body === null) {
    response.writeHead(413, { "content-type": "text/plain" }).end("Request body too large.");
    return;
  }
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!hopHeaders.has(name) && value !== undefined) headers[name] = value;
  }
  const upstream = await fetch(new URL(request.url, controlUrl), {
    method: request.method,
    headers,
    body: body.byteLength === 0 ? undefined : body,
    redirect: "manual",
  });
  const responseHeaders = {};
  upstream.headers.forEach((value, name) => {
    if (name !== "set-cookie" && name !== "content-length" && name !== "content-encoding" &&
      name !== "transfer-encoding" && name !== "connection") {
      responseHeaders[name] = value;
    }
  });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length > 0) responseHeaders["set-cookie"] = cookies;
  const payload = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, { ...responseHeaders, "content-length": payload.byteLength });
  response.end(payload);
}

async function serveStatic(request, response) {
  const pathname = new URL(request.url, "http://console.invalid").pathname;
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/u, "");
  const extension = extname(relative);
  // Any path without a file extension is a client-side route and gets the app shell.
  const file = extension === "" ? join(publicDir, "index.html") : join(publicDir, relative);
  if (!file.startsWith(publicDir)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found.");
  }
}

export function createConsoleListener(controlUrl) {
  return (request, response) => {
    const handled = request.url?.startsWith("/v1/")
      ? proxy(request, response, controlUrl)
      : request.method === "GET" || request.method === "HEAD"
        ? serveStatic(request, response)
        : Promise.resolve(response.writeHead(405).end());
    handled.catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" });
      }
      response.end("The control plane could not be reached.");
    });
  };
}

export async function startConsoleServer(environment = process.env) {
  const controlUrl = new URL(environment.CRAWLUME_CONSOLE_CONTROL_URL ?? "http://127.0.0.1:8787");
  const host = environment.CRAWLUME_CONSOLE_HOST ?? "127.0.0.1";
  const port = Number(environment.CRAWLUME_CONSOLE_PORT ?? "5173");
  const certPath = environment.CRAWLUME_CONSOLE_TLS_CERT_PATH;
  const keyPath = environment.CRAWLUME_CONSOLE_TLS_KEY_PATH;
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new Error("CRAWLUME_CONSOLE_TLS_CERT_PATH and CRAWLUME_CONSOLE_TLS_KEY_PATH are required together.");
  }
  const listener = createConsoleListener(controlUrl);
  const server = certPath === undefined
    ? createHttpServer(listener)
    : createHttpsServer({ cert: await readFile(certPath), key: await readFile(keyPath) }, listener);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const origin = `${certPath === undefined ? "http" : "https"}://${host}:${address.port}`;
  return { server, origin };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startConsoleServer();
  process.stdout.write(`Crawlume console listening on ${origin}\n`);
}
