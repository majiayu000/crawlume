import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  AccessTokenAuthenticationError,
  OidcAuthenticationError,
  RefreshTokenAuthenticationError,
  RefreshTokenReuseError,
  RefreshTokenRotationConflictError,
  type OidcLoginResult,
  type OidcLoginStart,
  type OidcSessionService,
  type SessionTokens,
} from "./oidc-session-service.js";
import type { WorkerHttpRequest, WorkerHttpResponse } from "./organization-service.js";
import { controlPlaneHeader } from "./project-http-api.js";

const oidcStateCookieName = "__Secure-diaoyan_oidc_state";
const refreshCookieName = "__Secure-diaoyan_refresh";
const oidcStateCookiePath = "/v1/auth/oidc/callback";
const refreshCookiePath = "/v1/auth";
const oidcStatePattern = /^[A-Za-z0-9_-]{43}$/u;
const refreshTokenPattern = /^dya_rt_[A-Za-z0-9_-]{43}$/u;

export const humanAuthRouteDefinitions = [
  {
    kind: "begin",
    method: "GET",
    path: "/auth/oidc/begin",
    operationId: "beginHumanOidcLogin",
    pattern: /^\/v1\/auth\/oidc\/begin$/u,
  },
  {
    kind: "callback",
    method: "GET",
    path: "/auth/oidc/callback",
    operationId: "completeHumanOidcLogin",
    pattern: /^\/v1\/auth\/oidc\/callback$/u,
  },
  {
    kind: "refresh",
    method: "POST",
    path: "/auth/refresh",
    operationId: "refreshHumanSession",
    pattern: /^\/v1\/auth\/refresh$/u,
  },
  {
    kind: "logout",
    method: "POST",
    path: "/auth/logout",
    operationId: "logoutHumanSession",
    pattern: /^\/v1\/auth\/logout$/u,
  },
] as const;

export const humanAuthRouterOperations = humanAuthRouteDefinitions.map(
  ({ method, operationId, path }) => ({ method, operationId, path }),
);

type HumanAuthRoute = (typeof humanAuthRouteDefinitions)[number];

type HumanAuthHttpServices = Readonly<{
  beginLogin: OidcSessionService["beginLogin"];
  completeLogin: OidcSessionService["completeLogin"];
  rotateRefreshToken: OidcSessionService["rotateRefreshToken"];
  verifyAccessToken: OidcSessionService["verifyAccessToken"];
  revokeAllUserSessions: OidcSessionService["revokeAllUserSessions"];
}>;

type HumanAuthHttpDependencies = Readonly<{ requestId?: () => string }>;

type HumanAuthProblem = Readonly<{
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  request_id: string;
  retryable: boolean;
}>;

class HumanAuthQueryError extends Error {
  readonly code = "AUTH_QUERY_INVALID";

  constructor() {
    super("The authentication query parameters are invalid or ambiguous.");
    this.name = "HumanAuthQueryError";
  }
}

class HumanAuthRequestError extends Error {
  readonly code = "AUTH_REQUEST_INVALID";

  constructor() {
    super("Authentication routes do not accept a request body.");
    this.name = "HumanAuthRequestError";
  }
}

function matchHumanAuthRoute(path: string): HumanAuthRoute | null {
  return humanAuthRouteDefinitions.find(({ pattern }) => pattern.test(path)) ?? null;
}

function requireNoQuery(request: WorkerHttpRequest): void {
  if ((request.query ?? "") !== "") throw new HumanAuthQueryError();
}

function requestHasBody(request: WorkerHttpRequest): boolean {
  if (request.body !== null) return true;
  if (Object.keys(request.headers).some((name) => name.toLowerCase() === "transfer-encoding")) {
    return true;
  }
  const contentLengths = Object.entries(request.headers)
    .filter(([name]) => name.toLowerCase() === "content-length");
  return contentLengths.length > 0 &&
    (contentLengths.length !== 1 || contentLengths[0]?.[1] !== "0");
}

function callbackQuery(request: WorkerHttpRequest): Readonly<{ state: string; code: string }> {
  const parameters = new URLSearchParams(request.query ?? "");
  for (const key of parameters.keys()) {
    if (key !== "state" && key !== "code") throw new HumanAuthQueryError();
  }
  const states = parameters.getAll("state");
  const codes = parameters.getAll("code");
  if (
    states.length !== 1 ||
    codes.length !== 1 ||
    !oidcStatePattern.test(states[0] ?? "") ||
    (codes[0]?.trim().length ?? 0) === 0
  ) {
    throw new HumanAuthQueryError();
  }
  return Object.freeze({ state: states[0]!, code: codes[0]! });
}

function cookieValue(request: WorkerHttpRequest, name: string): string | null {
  const header = controlPlaneHeader(request, "cookie");
  if (header === null) return null;
  const matches: string[] = [];
  for (const part of header.split(";")) {
    const cookie = part.trim();
    const separator = cookie.indexOf("=");
    if (separator <= 0) return null;
    const cookieName = cookie.slice(0, separator).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(cookieName)) return null;
    if (cookieName === name) matches.push(cookie.slice(separator + 1));
  }
  return matches.length === 1 && matches[0] !== "" ? matches[0]! : null;
}

function browserStateMatches(request: WorkerHttpRequest, state: string): boolean {
  const storedState = cookieValue(request, oidcStateCookieName);
  if (storedState === null || !oidcStatePattern.test(storedState) || !oidcStatePattern.test(state)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(storedState), Buffer.from(state));
}

function bearerAccessToken(request: WorkerHttpRequest): string {
  const authorization = controlPlaneHeader(request, "authorization");
  const matched = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(
    authorization ?? "",
  );
  if (matched?.[1] === undefined) throw new AccessTokenAuthenticationError();
  return matched[1];
}

function requireCookieMaterial(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error("The authentication service returned invalid cookie material.");
}

function persistentCookie(
  name: string,
  value: string,
  path: string,
  expiresAt: Date,
  sameSite: "Lax" | "Strict",
): string {
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("The authentication service returned an invalid cookie expiration.");
  }
  return `${name}=${value}; Path=${path}; Expires=${expiresAt.toUTCString()}; ` +
    `Secure; HttpOnly; SameSite=${sameSite}`;
}

function stateCookie(state: string, expiresAt: Date): string {
  requireCookieMaterial(state, oidcStatePattern);
  return persistentCookie(oidcStateCookieName, state, oidcStateCookiePath, expiresAt, "Lax");
}

function refreshCookie(token: string, expiresAt: Date): string {
  requireCookieMaterial(token, refreshTokenPattern);
  return persistentCookie(refreshCookieName, token, refreshCookiePath, expiresAt, "Strict");
}

function clearCookie(name: string, path: string, sameSite: "Lax" | "Strict"): string {
  return `${name}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ` +
    `Secure; HttpOnly; SameSite=${sameSite}`;
}

const clearStateCookie = () => clearCookie(oidcStateCookieName, oidcStateCookiePath, "Lax");
const clearRefreshCookie = () => clearCookie(refreshCookieName, refreshCookiePath, "Strict");

function authResponse(
  status: number,
  requestId: string,
  body: unknown | null,
  headers: Readonly<Record<string, string | string[]>> = {},
): WorkerHttpResponse {
  return {
    status,
    headers: {
      "x-request-id": requestId,
      ...(body === null ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body,
  };
}

function authProblem(
  request: WorkerHttpRequest,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  headers: Readonly<Record<string, string | string[]>> = {},
): WorkerHttpResponse {
  const body: HumanAuthProblem = {
    type: `https://api.diaoyan.example/errors/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    detail,
    instance: request.path,
    code,
    request_id: requestId,
    retryable: status === 500,
  };
  return authResponse(status, requestId, body, {
    "content-type": "application/problem+json",
    ...headers,
  });
}

function accessTokenBody(requestId: string, tokens: SessionTokens): Record<string, unknown> {
  return {
    request_id: requestId,
    token_type: "Bearer",
    access_token: tokens.accessToken,
    access_token_expires_at: tokens.accessTokenExpiresAt.toISOString(),
  };
}

function loginBody(requestId: string, result: OidcLoginResult): Record<string, unknown> {
  return {
    ...accessTokenBody(requestId, result.tokens),
    user: {
      id: result.user.id,
      email: result.user.email,
      display_name: result.user.displayName,
    },
  };
}

function loginState(started: OidcLoginStart): string {
  const authorizationUrl = new URL(started.authorizationUrl);
  const states = authorizationUrl.searchParams.getAll("state");
  if (states.length !== 1 || !oidcStatePattern.test(states[0] ?? "")) {
    throw new Error("The authentication service returned an invalid authorization state.");
  }
  return states[0]!;
}

export class HumanAuthHttpApi {
  private readonly requestId: () => string;

  constructor(
    private readonly services: HumanAuthHttpServices,
    dependencies: HumanAuthHttpDependencies = {},
  ) {
    this.requestId = dependencies.requestId ?? randomUUID;
  }

  async handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const requestId = this.requestId();
    const route = matchHumanAuthRoute(request.path);
    if (route === null) {
      return authProblem(request, requestId, 404, "AUTH_ROUTE_NOT_FOUND", "Not Found",
        "The human authentication route does not exist.");
    }
    if (request.method.toUpperCase() !== route.method) {
      const result = authProblem(request, requestId, 405, "AUTH_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The human authentication route does not accept this method.");
      return { ...result, headers: { ...result.headers, allow: route.method } };
    }

    try {
      if (requestHasBody(request)) throw new HumanAuthRequestError();
      if (route.kind === "begin") {
        requireNoQuery(request);
        const started = await this.services.beginLogin();
        return authResponse(302, requestId, null, {
          location: started.authorizationUrl,
          "set-cookie": [stateCookie(loginState(started), started.expiresAt)],
        });
      }
      if (route.kind === "callback") {
        const { state, code } = callbackQuery(request);
        if (!browserStateMatches(request, state)) throw new OidcAuthenticationError();
        const completed = await this.services.completeLogin(state, code);
        return authResponse(200, requestId, loginBody(requestId, completed), {
          "set-cookie": [
            clearStateCookie(),
            refreshCookie(completed.tokens.refreshToken, completed.tokens.refreshTokenExpiresAt),
          ],
        });
      }
      if (route.kind === "refresh") {
        requireNoQuery(request);
        const rawToken = cookieValue(request, refreshCookieName);
        if (rawToken === null) throw new RefreshTokenAuthenticationError();
        const rotated = await this.services.rotateRefreshToken(rawToken);
        return authResponse(200, requestId, accessTokenBody(requestId, rotated), {
          "set-cookie": [refreshCookie(rotated.refreshToken, rotated.refreshTokenExpiresAt)],
        });
      }

      requireNoQuery(request);
      const subject = await this.services.verifyAccessToken(bearerAccessToken(request));
      await this.services.revokeAllUserSessions(subject.userId);
      return authResponse(204, requestId, null, { "set-cookie": [clearRefreshCookie()] });
    } catch (error) {
      return this.errorResponse(request, requestId, route, error);
    }
  }

  private errorResponse(
    request: WorkerHttpRequest,
    requestId: string,
    route: HumanAuthRoute,
    error: unknown,
  ): WorkerHttpResponse {
    const stateCleanup = route.kind === "callback" ? { "set-cookie": [clearStateCookie()] } : {};
    if (error instanceof HumanAuthQueryError || error instanceof HumanAuthRequestError) {
      return authProblem(request, requestId, 400, error.code, "Authentication Request Invalid",
        error.message, stateCleanup);
    }
    if (error instanceof OidcAuthenticationError) {
      return authProblem(request, requestId, 401, error.code, "OIDC Authentication Failed",
        error.message, stateCleanup);
    }
    if (error instanceof RefreshTokenRotationConflictError) {
      return authProblem(request, requestId, 409, error.code, "Refresh Token Rotation Conflict",
        error.message);
    }
    if (error instanceof RefreshTokenAuthenticationError || error instanceof RefreshTokenReuseError) {
      return authProblem(request, requestId, 401, error.code, "Refresh Token Invalid", error.message, {
        "set-cookie": [clearRefreshCookie()],
      });
    }
    if (error instanceof AccessTokenAuthenticationError) {
      return authProblem(request, requestId, 401, error.code, "Access Token Invalid", error.message, {
        "www-authenticate": "Bearer",
      });
    }
    return authProblem(request, requestId, 500, "INTERNAL_ERROR", "Internal Server Error",
      "The human authentication request could not be completed.", stateCleanup);
  }
}
