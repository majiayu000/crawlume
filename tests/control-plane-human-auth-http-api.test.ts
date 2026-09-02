import { describe, expect, it, vi } from "vitest";

import {
  AccessTokenAuthenticationError,
  OidcAuthenticationError,
  RefreshTokenAuthenticationError,
  RefreshTokenReuseError,
  RefreshTokenRotationConflictError,
  type OidcLoginResult,
  type OidcLoginStart,
  type SessionTokens,
} from "../src/control-plane/oidc-session-service.js";
import {
  HumanAuthHttpApi,
  humanAuthRouteDefinitions,
} from "../src/control-plane/human-auth-http-api.js";
import type { WorkerHttpRequest } from "../src/control-plane/organization-service.js";

const requestId = "77777777-7777-4777-8777-777777777777";
const userId = "55555555-5555-4555-8555-555555555555";
const state = "A".repeat(43);
const otherState = "B".repeat(43);
const refreshToken = `dya_rt_${"C".repeat(43)}`;
const rotatedRefreshToken = `dya_rt_${"D".repeat(43)}`;
const accessToken = "aaa.bbb.ccc";
const rotatedAccessToken = "ddd.eee.fff";
const accessTokenExpiresAt = new Date("2026-09-03T08:10:00.000Z");
const refreshTokenExpiresAt = new Date("2026-10-03T08:00:00.000Z");
const stateExpiresAt = new Date("2026-09-03T08:10:00.000Z");

const loginStart: OidcLoginStart = Object.freeze({
  authorizationUrl: `https://identity.example/authorize?state=${state}&client_id=diaoyan-web`,
  expiresAt: stateExpiresAt,
});
const tokens: SessionTokens = Object.freeze({
  accessToken,
  accessTokenExpiresAt,
  refreshToken,
  refreshTokenExpiresAt,
});
const loginResult: OidcLoginResult = Object.freeze({
  user: Object.freeze({ id: userId, email: "person@example.com", displayName: "Example Person" }),
  tokens,
});

function request(overrides: Partial<WorkerHttpRequest> = {}): WorkerHttpRequest {
  return {
    method: "GET",
    path: "/v1/auth/oidc/begin",
    query: "",
    headers: {},
    body: null,
    ...overrides,
  };
}

function harness(overrides: Partial<ConstructorParameters<typeof HumanAuthHttpApi>[0]> = {}) {
  const beginLogin = vi.fn(async () => loginStart);
  const completeLogin = vi.fn(async () => loginResult);
  const rotateRefreshToken = vi.fn(async () => Object.freeze({
    accessToken: rotatedAccessToken,
    accessTokenExpiresAt,
    refreshToken: rotatedRefreshToken,
    refreshTokenExpiresAt,
  }));
  const verifyAccessToken = vi.fn(async () => Object.freeze({ userId }));
  const revokeAllUserSessions = vi.fn(async () => 1);
  const api = new HumanAuthHttpApi({
    beginLogin,
    completeLogin,
    rotateRefreshToken,
    verifyAccessToken,
    revokeAllUserSessions,
    ...overrides,
  }, { requestId: () => requestId });
  return {
    api,
    beginLogin,
    completeLogin,
    rotateRefreshToken,
    verifyAccessToken,
    revokeAllUserSessions,
  };
}

function setCookies(result: Awaited<ReturnType<HumanAuthHttpApi["handle"]>>): readonly string[] {
  const header = result.headers["set-cookie"];
  if (typeof header === "string") return [header];
  return header ?? [];
}

describe("Human Auth HTTP API", () => {
  it("exports the four bounded route contracts", () => {
    expect(humanAuthRouteDefinitions.map(({ method, path, operationId }) => ({
      method,
      path,
      operationId,
    }))).toEqual([
      { method: "GET", path: "/auth/oidc/begin", operationId: "beginHumanOidcLogin" },
      { method: "GET", path: "/auth/oidc/callback", operationId: "completeHumanOidcLogin" },
      { method: "POST", path: "/auth/refresh", operationId: "refreshHumanSession" },
      { method: "POST", path: "/auth/logout", operationId: "logoutHumanSession" },
    ]);
  });

  it("begins OIDC with a browser-bound Secure HttpOnly Lax state cookie", async () => {
    const { api, beginLogin } = harness();

    const result = await api.handle(request());

    expect(result).toMatchObject({
      status: 302,
      headers: {
        location: loginStart.authorizationUrl,
        "x-request-id": requestId,
        "cache-control": "no-store",
        pragma: "no-cache",
      },
      body: null,
    });
    expect(beginLogin).toHaveBeenCalledOnce();
    expect(setCookies(result)).toEqual([
      `__Secure-diaoyan_oidc_state=${state}; Path=/v1/auth/oidc/callback; ` +
        `Expires=${stateExpiresAt.toUTCString()}; Secure; HttpOnly; SameSite=Lax`,
    ]);
  });

  it("completes login only for the initiating browser and never returns the refresh token", async () => {
    const { api, completeLogin } = harness();

    const result = await api.handle(request({
      path: "/v1/auth/oidc/callback",
      query: `?state=${state}&code=authorization-code`,
      headers: { cookie: `theme=dark; __Secure-diaoyan_oidc_state=${state}` },
    }));

    expect(completeLogin).toHaveBeenCalledWith(state, "authorization-code");
    expect(result).toMatchObject({
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: {
        request_id: requestId,
        user: { id: userId, email: "person@example.com", display_name: "Example Person" },
        token_type: "Bearer",
        access_token: accessToken,
        access_token_expires_at: accessTokenExpiresAt.toISOString(),
      },
    });
    expect(JSON.stringify(result.body)).not.toContain(refreshToken);
    expect(setCookies(result)).toEqual([
      "__Secure-diaoyan_oidc_state=; Path=/v1/auth/oidc/callback; Max-Age=0; " +
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax",
      `__Secure-diaoyan_refresh=${refreshToken}; Path=/v1/auth/refresh; ` +
        `Expires=${refreshTokenExpiresAt.toUTCString()}; Secure; HttpOnly; SameSite=Strict`,
    ]);
  });

  it("rejects callback state not bound to the browser before consuming it", async () => {
    const { api, completeLogin } = harness();

    const result = await api.handle(request({
      path: "/v1/auth/oidc/callback",
      query: `?state=${state}&code=authorization-code`,
      headers: { cookie: `__Secure-diaoyan_oidc_state=${otherState}` },
    }));

    expect(result).toMatchObject({
      status: 401,
      headers: { "content-type": "application/problem+json" },
      body: { code: "OIDC_AUTHENTICATION_FAILED", request_id: requestId, retryable: false },
    });
    expect(completeLogin).not.toHaveBeenCalled();
    expect(result.headers).not.toHaveProperty("set-cookie");
  });

  it.each([
    "?state=A&state=B&code=authorization-code",
    `?state=${state}&code=one&code=two`,
    `?state=${state}`,
    `?state=${state}&code=%20`,
    `?state=${state}&code=authorization-code&error=access_denied`,
  ])("rejects malformed or ambiguous callback query %s", async (query) => {
    const { api, completeLogin } = harness();
    const result = await api.handle(request({
      path: "/v1/auth/oidc/callback",
      query,
      headers: { cookie: `__Secure-diaoyan_oidc_state=${state}` },
    }));

    expect(result).toMatchObject({ status: 400, body: { code: "AUTH_QUERY_INVALID" } });
    expect(completeLogin).not.toHaveBeenCalled();
    expect(result.headers).not.toHaveProperty("set-cookie");
  });

  it.each([
    { cookie: `__Secure-diaoyan_oidc_state=${state}; __Secure-diaoyan_oidc_state=${otherState}` },
    { cookie: [`__Secure-diaoyan_oidc_state=${state}`, `__Secure-diaoyan_oidc_state=${otherState}`] },
  ])("rejects duplicate callback state cookie material", async (headers) => {
    const { api, completeLogin } = harness();
    const result = await api.handle(request({
      path: "/v1/auth/oidc/callback",
      query: `?state=${state}&code=authorization-code`,
      headers,
    }));

    expect(result).toMatchObject({ status: 401, body: { code: "OIDC_AUTHENTICATION_FAILED" } });
    expect(completeLogin).not.toHaveBeenCalled();
    expect(result.headers).not.toHaveProperty("set-cookie");
  });

  it("clears state and returns one redacted OIDC failure for a provider denial", async () => {
    const { api, completeLogin } = harness();
    const result = await api.handle(request({
      path: "/v1/auth/oidc/callback",
      query: `?state=${state}&error=access_denied&error_description=private-provider-detail&` +
        "error_uri=https%3A%2F%2Fidentity.example%2Fprivate-error",
      headers: { cookie: `__Secure-diaoyan_oidc_state=${state}` },
    }));

    expect(result).toMatchObject({
      status: 401,
      body: { code: "OIDC_AUTHENTICATION_FAILED", request_id: requestId },
    });
    expect(completeLogin).not.toHaveBeenCalled();
    expect(setCookies(result)[0]).toContain("__Secure-diaoyan_oidc_state=;");
    expect(JSON.stringify(result)).not.toContain("private-provider-detail");
    expect(JSON.stringify(result)).not.toContain("private-error");
    expect(JSON.stringify(result)).not.toContain("access_denied");
  });

  it("rotates the refresh cookie and returns only a short-lived Access Token", async () => {
    const { api, rotateRefreshToken } = harness();

    const result = await api.handle(request({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { cookie: `theme=dark; __Secure-diaoyan_refresh=${refreshToken}` },
    }));

    expect(rotateRefreshToken).toHaveBeenCalledWith(refreshToken);
    expect(result).toMatchObject({
      status: 200,
      body: {
        request_id: requestId,
        token_type: "Bearer",
        access_token: rotatedAccessToken,
        access_token_expires_at: accessTokenExpiresAt.toISOString(),
      },
    });
    expect(JSON.stringify(result.body)).not.toContain(rotatedRefreshToken);
    expect(setCookies(result)).toEqual([
      `__Secure-diaoyan_refresh=${rotatedRefreshToken}; Path=/v1/auth/refresh; ` +
        `Expires=${refreshTokenExpiresAt.toUTCString()}; Secure; HttpOnly; SameSite=Strict`,
    ]);
  });

  it.each([
    { headers: {}, label: "missing" },
    {
      headers: { cookie: `__Secure-diaoyan_refresh=${refreshToken}; __Secure-diaoyan_refresh=${rotatedRefreshToken}` },
      label: "duplicate cookie",
    },
    { headers: { cookie: ["one", "two"] }, label: "duplicate header" },
  ])("fails closed for a $label refresh cookie", async ({ headers }) => {
    const { api, rotateRefreshToken } = harness();
    const result = await api.handle(request({ method: "POST", path: "/v1/auth/refresh", headers }));

    expect(result).toMatchObject({ status: 401, body: { code: "REFRESH_TOKEN_INVALID" } });
    expect(rotateRefreshToken).not.toHaveBeenCalled();
    expect(setCookies(result)[0]).toContain("__Secure-diaoyan_refresh=;");
  });

  it("does not overwrite the winning cookie on a concurrent refresh conflict", async () => {
    const { api } = harness({
      rotateRefreshToken: vi.fn(async () => { throw new RefreshTokenRotationConflictError(); }),
    });
    const result = await api.handle(request({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { cookie: `__Secure-diaoyan_refresh=${refreshToken}` },
    }));

    expect(result).toMatchObject({
      status: 409,
      body: { code: "REFRESH_TOKEN_ROTATION_CONFLICT", retryable: false },
    });
    expect(result.headers).not.toHaveProperty("set-cookie");
  });

  it.each([
    new RefreshTokenAuthenticationError(),
    new RefreshTokenReuseError(),
  ])("clears the local refresh cookie after %s", async (error) => {
    const { api } = harness({ rotateRefreshToken: vi.fn(async () => { throw error; }) });
    const result = await api.handle(request({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { cookie: `__Secure-diaoyan_refresh=${refreshToken}` },
    }));

    expect(result).toMatchObject({ status: 401, body: { code: error.code } });
    expect(setCookies(result)[0]).toContain("Max-Age=0");
  });

  it("logs out every server-side family and clears the browser refresh cookie", async () => {
    const { api, verifyAccessToken, revokeAllUserSessions } = harness();
    const result = await api.handle(request({
      method: "POST",
      path: "/v1/auth/logout",
      headers: { authorization: `bEaReR ${accessToken}` },
    }));

    expect(verifyAccessToken).toHaveBeenCalledWith(accessToken);
    expect(revokeAllUserSessions).toHaveBeenCalledWith(userId);
    expect(result).toMatchObject({ status: 204, body: null });
    expect(result.headers).not.toHaveProperty("content-type");
    expect(setCookies(result)[0]).toContain(
      "__Secure-diaoyan_refresh=; Path=/v1/auth/refresh;",
    );
  });

  it.each([
    {},
    { authorization: ["Bearer aaa.bbb.ccc", "Bearer ddd.eee.fff"] },
  ])("rejects missing or duplicate logout authorization", async (headers) => {
    const { api, revokeAllUserSessions } = harness({
      verifyAccessToken: vi.fn(async () => { throw new AccessTokenAuthenticationError(); }),
    });
    const result = await api.handle(request({ method: "POST", path: "/v1/auth/logout", headers }));

    expect(result).toMatchObject({
      status: 401,
      headers: { "www-authenticate": "Bearer" },
      body: { code: "ACCESS_TOKEN_INVALID" },
    });
    expect(revokeAllUserSessions).not.toHaveBeenCalled();
    expect(result.headers).not.toHaveProperty("set-cookie");
  });

  it("rejects unsupported routes, methods, query, and request bodies before authentication", async () => {
    const active = harness();
    await expect(active.api.handle(request({ path: "/v1/auth/unknown" })))
      .resolves.toMatchObject({ status: 404, body: { code: "AUTH_ROUTE_NOT_FOUND" } });
    await expect(active.api.handle(request({ method: "POST" })))
      .resolves.toMatchObject({ status: 405, headers: { allow: "GET" } });
    await expect(active.api.handle(request({ query: "?next=/" })))
      .resolves.toMatchObject({ status: 400, body: { code: "AUTH_QUERY_INVALID" } });
    await expect(active.api.handle(request({ body: {} })))
      .resolves.toMatchObject({ status: 400, body: { code: "AUTH_REQUEST_INVALID" } });
    await expect(active.api.handle(request({ headers: { "content-length": "4" } })))
      .resolves.toMatchObject({ status: 400, body: { code: "AUTH_REQUEST_INVALID" } });
    await expect(active.api.handle(request({ headers: { "transfer-encoding": "chunked" } })))
      .resolves.toMatchObject({ status: 400, body: { code: "AUTH_REQUEST_INVALID" } });
    await expect(active.api.handle(request({
      headers: { "content-length": "0", "transfer-encoding": "chunked" },
    }))).resolves.toMatchObject({ status: 400, body: { code: "AUTH_REQUEST_INVALID" } });
    expect(active.beginLogin).not.toHaveBeenCalled();
  });

  it("redacts unexpected failures behind one retryable Problem Detail", async () => {
    const beginLogin = vi.fn(async () => { throw new Error("database password leaked"); });
    const { api } = harness({ beginLogin });
    const result = await api.handle(request());

    expect(result).toMatchObject({
      status: 500,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        pragma: "no-cache",
      },
      body: { code: "INTERNAL_ERROR", retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain("database password leaked");
  });

  it("maps OIDC service failures without exposing their causes", async () => {
    const { api } = harness({
      completeLogin: vi.fn(async () => { throw new OidcAuthenticationError(new Error("provider body")); }),
    });
    const result = await api.handle(request({
      path: "/v1/auth/oidc/callback",
      query: `?state=${state}&code=authorization-code`,
      headers: { cookie: `__Secure-diaoyan_oidc_state=${state}` },
    }));

    expect(result).toMatchObject({ status: 401, body: { code: "OIDC_AUTHENTICATION_FAILED" } });
    expect(JSON.stringify(result)).not.toContain("provider body");
  });
});
