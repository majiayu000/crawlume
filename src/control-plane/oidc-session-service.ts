import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
  type KeyInput,
} from "jose";

import type {
  AuthenticatedUser,
  ControlPlaneDatabase,
  ControlPlaneQuery,
} from "./project-scope.js";

const loginAttemptTtlSeconds = 10 * 60;
const loginAttemptCooldownSeconds = 1;
const oidcLoginBudgetLockNamespace = "diaoyan:oidc-login-budget";
const accessTokenTtlSeconds = 10 * 60;
const refreshFamilyTtlMs = 30 * 24 * 60 * 60 * 1_000;
const refreshRotationGraceMs = 5_000;
const maximumTokenResponseBytes = 64 * 1_024;

export type OidcIdTokenAlgorithm = "RS256" | "PS256" | "ES256" | "EdDSA";
export type OidcVerificationKey = KeyInput | JWTVerifyGetKey;

export type OidcSessionConfig = Readonly<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  idTokenAlgorithms: readonly OidcIdTokenAlgorithm[];
  idTokenVerificationKey: OidcVerificationKey;
  accessTokenIssuer: string;
  accessTokenAudience: string;
  accessTokenPrivateKey: KeyInput;
  accessTokenPublicKey: KeyInput;
}>;

export type OidcLoginStart = Readonly<{
  authorizationUrl: string;
  expiresAt: Date;
}>;

export type SessionTokens = Readonly<{
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}>;

export type OidcLoginResult = Readonly<{
  user: Readonly<{
    id: string;
    email: string | null;
    displayName: string | null;
  }>;
  tokens: SessionTokens;
}>;

type LoginAttemptRow = {
  issuer: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
  nonce: string;
};

type UserRow = {
  id: string;
  email: string | null;
  display_name: string | null;
};

type IdRow = { id: string };
type AdvisoryLockRow = { acquired: boolean };
type LoginAttemptInsertRow = IdRow & { created_at: Date; expires_at: Date };
type BeginLoginOutcome =
  | { kind: "created"; expiresAt: Date }
  | { kind: "rate-limited" };

type RefreshTokenRow = {
  id: string;
  family_id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
};

type ActiveSessionRow = { active: boolean };

type OidcClaims = {
  sub?: unknown;
  nonce?: unknown;
  email?: unknown;
  name?: unknown;
  preferred_username?: unknown;
};

type RefreshMaterial = {
  id: string;
  familyId: string;
  rawToken: string;
  tokenHash: Buffer;
};

type RotationOutcome =
  | { kind: "success"; tokens: SessionTokens }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "reuse" };

export class OidcAuthenticationError extends Error {
  readonly code = "OIDC_AUTHENTICATION_FAILED";

  constructor(cause?: unknown) {
    super("The OIDC login could not be authenticated.", cause === undefined ? undefined : { cause });
    this.name = "OidcAuthenticationError";
  }
}

export class OidcLoginRateLimitedError extends Error {
  readonly code = "OIDC_LOGIN_RATE_LIMITED";
  readonly retryAfterSeconds = loginAttemptCooldownSeconds;

  constructor() {
    super("OIDC login initiation is temporarily rate limited.");
    this.name = "OidcLoginRateLimitedError";
  }
}

export class RefreshTokenAuthenticationError extends Error {
  readonly code = "REFRESH_TOKEN_INVALID";

  constructor() {
    super("The refresh token is invalid, expired, or revoked.");
    this.name = "RefreshTokenAuthenticationError";
  }
}

export class RefreshTokenReuseError extends Error {
  readonly code = "REFRESH_TOKEN_REUSE";

  constructor() {
    super("Refresh token reuse was detected and its token family was revoked.");
    this.name = "RefreshTokenReuseError";
  }
}

export class RefreshTokenRotationConflictError extends Error {
  readonly code = "REFRESH_TOKEN_ROTATION_CONFLICT";

  constructor() {
    super("The refresh token was already rotated by another request.");
    this.name = "RefreshTokenRotationConflictError";
  }
}

export class AccessTokenAuthenticationError extends Error {
  readonly code = "ACCESS_TOKEN_INVALID";

  constructor(cause?: unknown) {
    super("The access token is invalid or its session was revoked.", cause === undefined ? undefined : { cause });
    this.name = "AccessTokenAuthenticationError";
  }
}

function requireIdentityValue(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function requireHttpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be an absolute URL.`, { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS.`);
  }
  return url;
}

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function randomBase64Url(): string {
  return randomBytes(32).toString("base64url");
}

function createRefreshMaterial(familyId = randomUUID()): RefreshMaterial {
  const rawToken = `dya_rt_${randomBase64Url()}`;
  return {
    id: randomUUID(),
    familyId,
    rawToken,
    tokenHash: hashSecret(rawToken),
  };
}

function requireRefreshTokenFormat(token: string): void {
  if (!/^dya_rt_[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new RefreshTokenAuthenticationError();
  }
}

function claimString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") || response.body === null) {
    throw new OidcAuthenticationError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumTokenResponseBytes) {
        await reader.cancel();
        throw new OidcAuthenticationError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new OidcAuthenticationError(error);
  }
}

export function createOidcRemoteJwkSet(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(requireHttpsUrl(jwksUri, "jwksUri"));
}

export class OidcSessionService {
  private readonly authorizationEndpoint: URL;
  private readonly tokenEndpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly config: OidcSessionConfig,
    dependencies: Readonly<{
      fetch?: typeof fetch;
      now?: () => Date;
    }> = {},
  ) {
    requireHttpsUrl(config.issuer, "config.issuer");
    this.authorizationEndpoint = requireHttpsUrl(
      config.authorizationEndpoint,
      "config.authorizationEndpoint",
    );
    this.tokenEndpoint = requireHttpsUrl(config.tokenEndpoint, "config.tokenEndpoint");
    requireIdentityValue(config.clientId, "config.clientId");
    try {
      new URL(config.redirectUri);
    } catch (error) {
      throw new Error("config.redirectUri must be an absolute URL.", { cause: error });
    }
    requireHttpsUrl(config.accessTokenIssuer, "config.accessTokenIssuer");
    requireIdentityValue(config.accessTokenAudience, "config.accessTokenAudience");
    if (config.idTokenAlgorithms.length === 0) {
      throw new Error("At least one OIDC ID Token algorithm must be configured.");
    }
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
  }

  async beginLogin(): Promise<OidcLoginStart> {
    const state = randomBase64Url();
    const nonce = randomBase64Url();
    const codeVerifier = randomBase64Url();
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const lockSubject = JSON.stringify([
      oidcLoginBudgetLockNamespace,
      this.config.issuer,
      this.config.clientId,
    ]);
    const outcome = await this.database.transaction<BeginLoginOutcome>(async (transaction) => {
      const lock = await transaction.query<AdvisoryLockRow>(`
        SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired
      `, [lockSubject]);
      if (lock.rows[0]?.acquired !== true) return { kind: "rate-limited" };

      await transaction.query(`
        DELETE FROM oidc_login_attempts
        WHERE issuer = $1 AND client_id = $2
          AND (
            (consumed_at IS NULL AND expires_at <= clock_timestamp()) OR
            (consumed_at <= clock_timestamp() - make_interval(secs => $3::integer))
          )
      `, [this.config.issuer, this.config.clientId, loginAttemptCooldownSeconds]);

      const inserted = await transaction.query<LoginAttemptInsertRow>(`
        INSERT INTO oidc_login_attempts(
          id, state_hash, issuer, client_id, redirect_uri,
          code_verifier, nonce, created_at, expires_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7,
          clock_timestamp(),
          clock_timestamp() + make_interval(secs => $8::integer)
        WHERE NOT EXISTS (
          SELECT 1
          FROM oidc_login_attempts
          WHERE issuer = $3 AND client_id = $4
            AND created_at > clock_timestamp() - make_interval(secs => $9::integer)
        )
        RETURNING id, created_at, expires_at
      `, [
        randomUUID(), hashSecret(state), this.config.issuer, this.config.clientId,
        this.config.redirectUri, codeVerifier, nonce,
        loginAttemptTtlSeconds, loginAttemptCooldownSeconds,
      ]);
      const attempt = inserted.rows[0];
      return attempt === undefined
        ? { kind: "rate-limited" }
        : { kind: "created", expiresAt: attempt.expires_at };
    });
    if (outcome.kind === "rate-limited") throw new OidcLoginRateLimitedError();

    const authorizationUrl = new URL(this.authorizationEndpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", this.config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", this.config.redirectUri);
    authorizationUrl.searchParams.set("scope", "openid profile email");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    return Object.freeze({ authorizationUrl: authorizationUrl.toString(), expiresAt: outcome.expiresAt });
  }

  async completeLogin(state: string, code: string): Promise<OidcLoginResult> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) throw new OidcAuthenticationError();
    requireIdentityValue(code, "code");

    const consumed = await this.database.query<LoginAttemptRow>(`
      UPDATE oidc_login_attempts
      SET consumed_at = CURRENT_TIMESTAMP
      WHERE state_hash = $1
        AND consumed_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      RETURNING issuer, client_id, redirect_uri, code_verifier, nonce
    `, [hashSecret(state)]);
    const attempt = consumed.rows[0];
    if (attempt === undefined) throw new OidcAuthenticationError();
    if (
      attempt.issuer !== this.config.issuer ||
      attempt.client_id !== this.config.clientId ||
      attempt.redirect_uri !== this.config.redirectUri
    ) {
      throw new OidcAuthenticationError();
    }

    const idToken = await this.exchangeAuthorizationCode(code, attempt.code_verifier);
    const claims = await this.verifyOidcIdToken(idToken, attempt.nonce);
    const subject = claimString(claims.sub);
    if (subject === null) throw new OidcAuthenticationError();
    const email = claimString(claims.email);
    const displayName = claimString(claims.name) ?? claimString(claims.preferred_username);
    const now = this.now();
    const refresh = createRefreshMaterial();
    const refreshExpiresAt = new Date(now.getTime() + refreshFamilyTtlMs);

    return this.database.transaction(async (transaction) => {
      const user = await this.provisionUser(transaction, subject, email, displayName);
      const accessToken = await this.signAccessToken(user.id, refresh.familyId, now);
      const inserted = await transaction.query<IdRow>(`
        INSERT INTO refresh_tokens(
          id, family_id, user_id, token_hash, created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        refresh.id,
        refresh.familyId,
        user.id,
        refresh.tokenHash,
        now,
        refreshExpiresAt,
      ]);
      if (inserted.rows[0] === undefined) {
        throw new Error("The refresh token insert returned no record.");
      }
      return Object.freeze({
        user: Object.freeze({
          id: user.id,
          email: user.email,
          displayName: user.display_name,
        }),
        tokens: this.sessionTokens(accessToken, refresh.rawToken, now, refreshExpiresAt),
      });
    });
  }

  async rotateRefreshToken(rawToken: string): Promise<SessionTokens> {
    requireRefreshTokenFormat(rawToken);
    const outcome = await this.database.transaction<RotationOutcome>(async (transaction) => {
      const selected = await transaction.query<RefreshTokenRow>(`
        SELECT id, family_id, user_id, expires_at, used_at, revoked_at
        FROM refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE
      `, [hashSecret(rawToken)]);
      const current = selected.rows[0];
      if (current === undefined) return { kind: "invalid" };
      const now = this.now();

      if (current.revoked_at !== null || current.expires_at.getTime() <= now.getTime()) {
        return { kind: "invalid" };
      }
      if (
        current.used_at !== null &&
        now.getTime() <= current.used_at.getTime() + refreshRotationGraceMs
      ) {
        return { kind: "conflict" };
      }
      if (current.used_at !== null) {
        await transaction.query<IdRow>(`
          UPDATE refresh_tokens
          SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
          WHERE user_id = $1 AND family_id = $2
          RETURNING id
        `, [current.user_id, current.family_id]);
        return { kind: "reuse" };
      }

      const replacement = createRefreshMaterial();
      const accessToken = await this.signAccessToken(current.user_id, current.family_id, now);
      const marked = await transaction.query<IdRow>(`
        UPDATE refresh_tokens
        SET used_at = $2
        WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
        RETURNING id
      `, [current.id, now]);
      if (marked.rows[0] === undefined) return { kind: "invalid" };

      const inserted = await transaction.query<IdRow>(`
        INSERT INTO refresh_tokens(
          id, family_id, user_id, token_hash, previous_token_id,
          created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [
        replacement.id,
        current.family_id,
        current.user_id,
        replacement.tokenHash,
        current.id,
        now,
        current.expires_at,
      ]);
      if (inserted.rows[0] === undefined) {
        throw new Error("The rotated refresh token insert returned no record.");
      }
      return {
        kind: "success",
        tokens: this.sessionTokens(
          accessToken,
          replacement.rawToken,
          now,
          current.expires_at,
        ),
      };
    });

    if (outcome.kind === "conflict") throw new RefreshTokenRotationConflictError();
    if (outcome.kind === "reuse") throw new RefreshTokenReuseError();
    if (outcome.kind === "invalid") throw new RefreshTokenAuthenticationError();
    return outcome.tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.config.accessTokenPublicKey, {
        algorithms: ["EdDSA"],
        issuer: this.config.accessTokenIssuer,
        audience: this.config.accessTokenAudience,
        typ: "JWT",
        clockTolerance: 30,
        currentDate: this.now(),
        maxTokenAge: accessTokenTtlSeconds,
        requiredClaims: ["sub", "sid", "jti", "iat", "exp"],
      }));
    } catch (error) {
      throw new AccessTokenAuthenticationError(error);
    }
    const userId = claimString(payload.sub);
    const familyId = claimString(payload.sid);
    if (userId === null || familyId === null) {
      throw new AccessTokenAuthenticationError();
    }

    const session = await this.database.query<ActiveSessionRow>(`
      SELECT EXISTS(
        SELECT 1
        FROM refresh_tokens
        WHERE family_id = $1
          AND user_id = $2
          AND revoked_at IS NULL
          AND used_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP
      ) AS active
    `, [familyId, userId]);
    if (session.rows[0]?.active !== true) {
      throw new AccessTokenAuthenticationError();
    }
    return Object.freeze({ userId });
  }

  async revokeAllUserSessions(userId: string): Promise<number> {
    requireIdentityValue(userId, "userId");
    const revoked = await this.database.query<IdRow>(`
      UPDATE refresh_tokens
      SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id
    `, [userId]);
    return revoked.rows.length;
  }

  private async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(this.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId,
          code_verifier: codeVerifier,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new OidcAuthenticationError(error);
    }
    if (!response.ok) throw new OidcAuthenticationError();
    const parsed = await boundedJson(response);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { id_token?: unknown }).id_token !== "string"
    ) {
      throw new OidcAuthenticationError();
    }
    return (parsed as { id_token: string }).id_token;
  }

  private async verifyOidcIdToken(idToken: string, nonce: string): Promise<OidcClaims> {
    try {
      const { payload } = await jwtVerify<OidcClaims>(
        idToken,
        this.config.idTokenVerificationKey,
        {
          algorithms: [...this.config.idTokenAlgorithms],
          issuer: this.config.issuer,
          audience: this.config.clientId,
          clockTolerance: 30,
          currentDate: this.now(),
          requiredClaims: ["sub", "iat", "exp", "nonce"],
        },
      );
      if (payload.nonce !== nonce) throw new OidcAuthenticationError();
      return payload;
    } catch (error) {
      if (error instanceof OidcAuthenticationError) throw error;
      throw new OidcAuthenticationError(error);
    }
  }

  private async provisionUser(
    transaction: ControlPlaneQuery,
    subject: string,
    email: string | null,
    displayName: string | null,
  ): Promise<UserRow> {
    const candidateUserId = randomUUID();
    const inserted = await transaction.query<UserRow>(`
      INSERT INTO users(id, oidc_issuer, oidc_subject, email, display_name)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (oidc_issuer, oidc_subject) DO NOTHING
      RETURNING id, email, display_name
    `, [candidateUserId, this.config.issuer, subject, email, displayName]);
    const created = inserted.rows[0];
    if (created !== undefined) {
      const organizationId = randomUUID();
      const projectId = randomUUID();
      const personalName = displayName ?? email ?? "Personal Organization";
      await transaction.query<IdRow>(`
        INSERT INTO organizations(id, slug, name, kind)
        VALUES ($1, $2, $3, 'personal')
        RETURNING id
      `, [organizationId, `personal-${created.id}`, personalName]);
      await transaction.query<IdRow>(`
        INSERT INTO organization_memberships(organization_id, user_id, role)
        VALUES ($1, $2, 'owner')
        RETURNING user_id AS id
      `, [organizationId, created.id]);
      await transaction.query<IdRow>(`
        INSERT INTO projects(id, organization_id, slug, name)
        VALUES ($1, $2, 'default', 'Default')
        RETURNING id
      `, [projectId, organizationId]);
      return created;
    }

    const existing = await transaction.query<UserRow>(`
      UPDATE users
      SET
        email = COALESCE($3, email),
        display_name = COALESCE($4, display_name),
        updated_at = CURRENT_TIMESTAMP
      WHERE oidc_issuer = $1 AND oidc_subject = $2
      RETURNING id, email, display_name
    `, [this.config.issuer, subject, email, displayName]);
    const user = existing.rows[0];
    if (user === undefined) {
      throw new Error("The OIDC user upsert returned no record.");
    }
    return user;
  }

  private async signAccessToken(userId: string, familyId: string, now: Date): Promise<string> {
    const issuedAt = Math.floor(now.getTime() / 1_000);
    return new SignJWT({ sid: familyId })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(this.config.accessTokenIssuer)
      .setAudience(this.config.accessTokenAudience)
      .setSubject(userId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + accessTokenTtlSeconds)
      .setJti(randomUUID())
      .sign(this.config.accessTokenPrivateKey);
  }

  private sessionTokens(
    accessToken: string,
    refreshToken: string,
    issuedAt: Date,
    refreshTokenExpiresAt: Date,
  ): SessionTokens {
    return Object.freeze({
      accessToken,
      accessTokenExpiresAt: new Date(issuedAt.getTime() + accessTokenTtlSeconds * 1_000),
      refreshToken,
      refreshTokenExpiresAt,
    });
  }
}
