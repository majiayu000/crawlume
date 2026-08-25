import { ReadError } from "./errors.js";
import type { HttpTransport } from "./fetch/http.js";
import {
  normalizeRslServer,
  RslClientCredentialStore,
  type RslClientCredential,
} from "./rsl-client-credentials.js";

const TOKEN_MAX_BYTES = 64 * 1024;
const TOKEN_MAX_LENGTH = 16 * 1024;

export type RslTokenRequest = {
  server: string;
  licenseHash: string;
  licenseXml: string;
  resource: string;
};

type CachedToken = {
  authorization: string;
  expiresAt: number;
};

function formEncode(value: string): string {
  const encoded = new URLSearchParams([["", value]]).toString();
  return encoded.slice(1);
}

function basicAuthorization(client: RslClientCredential): string {
  const value = `${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`;
  return `Basic ${Buffer.from(value, "utf8").toString("base64")}`;
}

function tokenKey(request: RslTokenRequest, client: RslClientCredential): string {
  return JSON.stringify([
    normalizeRslServer(request.server),
    request.licenseHash,
    request.resource,
    client.clientId,
  ]);
}

function tokenExpiry(now: number, expiresIn: number): number {
  if (expiresIn === 0) return Number.POSITIVE_INFINITY;
  const lifetimeMs = expiresIn * 1_000;
  const skewMs = Math.min(5_000, Math.floor(lifetimeMs / 10));
  const expiresAt = now + lifetimeMs - skewMs;
  return Number.isSafeInteger(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY;
}

export class RslOlpClient {
  private readonly credentials: RslClientCredentialStore;
  private readonly cache = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    clientsPath: string,
    private readonly transport: HttpTransport,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.credentials = new RslClientCredentialStore(clientsPath);
  }

  invalidate(authorization: string): void {
    for (const [key, token] of this.cache) {
      if (token.authorization === authorization) this.cache.delete(key);
    }
  }

  async acquire(request: RslTokenRequest): Promise<string> {
    const server = normalizeRslServer(request.server);
    const client = this.credentials.get(server);
    if (client === null) {
      throw new ReadError(
        "RSL_LICENSE_REQUIRED",
        "RSL requires a License Token, but no client is configured for the License Server.",
        { details: { licenseServer: server } },
      );
    }
    const key = tokenKey({ ...request, server }, client);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.authorization;
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;

    const acquisition = this.acquireFresh({ ...request, server }, client)
      .then((token) => {
        this.cache.set(key, token);
        return token.authorization;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, acquisition);
    return acquisition;
  }

  private async acquireFresh(
    request: RslTokenRequest,
    client: RslClientCredential,
  ): Promise<CachedToken> {
    const endpoint = new URL(`${request.server}/token`);
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      license: request.licenseXml,
      license_type: "application/rsl+xml",
      resource: request.resource,
    });
    let response;
    try {
      response = await this.transport.postForm(
        endpoint,
        form,
        basicAuthorization(client),
        TOKEN_MAX_BYTES,
      );
    } catch (error) {
      const retryable = error instanceof ReadError && error.retryable;
      throw new ReadError("RSL_LICENSE_REQUIRED", "The License Token request failed.", {
        retryable,
        details: { licenseServer: request.server },
      });
    }
    if (response.status !== 200) {
      throw new ReadError("RSL_LICENSE_REQUIRED", "The License Server did not issue a token.", {
        retryable: response.status >= 500,
        details: { licenseServer: request.server, httpStatus: response.status },
      });
    }
    if (response.contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new ReadError("RSL_LICENSE_REQUIRED", "The License Server returned an invalid response.", {
        details: { licenseServer: request.server, httpStatus: response.status },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new ReadError("RSL_LICENSE_REQUIRED", "The License Server returned invalid JSON.", {
        details: { licenseServer: request.server, httpStatus: response.status },
      });
    }
    const token = parsed as Record<string, unknown>;
    const expiresIn = token.expires_in;
    const issuedAt = this.now();
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof token.access_token !== "string" ||
      token.access_token.length === 0 ||
      token.access_token.length > TOKEN_MAX_LENGTH ||
      /[\r\n]/.test(token.access_token) ||
      token.token_type !== "License" ||
      !Number.isSafeInteger(expiresIn) ||
      (expiresIn as number) < 0 ||
      !Number.isSafeInteger((expiresIn as number) * 1_000) ||
      ((expiresIn as number) > 0 && !Number.isSafeInteger(issuedAt + (expiresIn as number) * 1_000))
    ) {
      throw new ReadError("RSL_LICENSE_REQUIRED", "The License Server returned an invalid token.", {
        details: { licenseServer: request.server, httpStatus: response.status },
      });
    }
    return {
      authorization: `License ${token.access_token}`,
      expiresAt: tokenExpiry(issuedAt, expiresIn as number),
    };
  }
}
