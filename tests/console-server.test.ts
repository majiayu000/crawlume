import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startConsoleServer } from "../console/server.mjs";

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

async function startConsole(controlUrl: string): Promise<string> {
  const { server, origin } = await startConsoleServer({
    CRAWLUME_CONSOLE_CONTROL_URL: controlUrl,
    CRAWLUME_CONSOLE_PORT: "0",
  });
  servers.push(server);
  return origin;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("console server", () => {
  it("proxies /v1 requests with method, query, body, auth and every Set-Cookie", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const control = await listen(createServer(async (request, response) => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        body: await body(request),
      });
      response.writeHead(201, {
        "content-type": "application/json",
        "set-cookie": ["a=1; Path=/v1/auth/refresh; HttpOnly", "b=2; Path=/v1/auth/oidc/callback"],
      });
      response.end('{"ok":true}');
    }));
    const origin = await startConsole(control);

    const response = await fetch(`${origin}/v1/projects/p/jobs?limit=5`, {
      method: "POST",
      headers: { authorization: "Bearer key", cookie: "c=3", "content-type": "application/json" },
      body: '{"type":"read"}',
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/v1/auth/refresh; HttpOnly",
      "b=2; Path=/v1/auth/oidc/callback",
    ]);
    expect(seen).toEqual([{
      method: "POST",
      url: "/v1/projects/p/jobs?limit=5",
      authorization: "Bearer key",
      cookie: "c=3",
      body: '{"type":"read"}',
    }]);
  });

  it("passes redirects through instead of following them", async () => {
    const control = await listen(createServer((_request, response) => {
      response.writeHead(302, { location: "https://idp.example/authorize" }).end();
    }));
    const origin = await startConsole(control);

    const response = await fetch(`${origin}/v1/auth/oidc/begin`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://idp.example/authorize");
  });

  it("serves the app shell for client routes and refuses paths outside the public directory", async () => {
    const origin = await startConsole("http://127.0.0.1:9");

    const callback = await fetch(`${origin}/callback?code=x&state=y`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('<main id="main">');
    expect(callback.headers.get("content-security-policy")).toContain("default-src 'self'");

    const style = await fetch(`${origin}/style.css`);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const escaped = await fetch(`${origin}/%2e%2e/server.mjs`);
    expect(escaped.status).toBe(404);
  });

  it("answers 502 when the control plane is unreachable", async () => {
    const origin = await startConsole("http://127.0.0.1:9");

    const response = await fetch(`${origin}/v1/organizations`);

    expect(response.status).toBe(502);
  });
});
