import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signMessage,
} from "node:crypto";

import { generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startControlPlaneRuntime,
  type ControlPlaneRuntime,
} from "../src/server.js";

const configuredDatabaseUrl = process.env.DIAOYAN_TEST_POSTGRES_URL;
const describeWithPostgres = configuredDatabaseUrl === undefined ? describe.skip : describe;

function requiredDatabaseUrl(): string {
  if (configuredDatabaseUrl === undefined) {
    throw new Error(
      "DIAOYAN_TEST_POSTGRES_URL is required. Run the dedicated `pnpm test:postgres` Gate.",
    );
  }
  return configuredDatabaseUrl;
}

function quotedTestDatabase(name: string): string {
  if (!/^diaoyan_bootstrap_test_[0-9a-f]{32}$/u.test(name)) {
    throw new Error(`Refusing to use an unexpected PostgreSQL test database name: ${name}`);
  }
  return `"${name}"`;
}

function databaseUrl(name: string): string {
  const url = new URL(requiredDatabaseUrl());
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DIAOYAN_TEST_POSTGRES_URL must use postgres or postgresql.");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

type TokenRequest = Readonly<{
  method: string | undefined;
  headers: Headers;
  form: URLSearchParams;
}>;

type LoginResponse = Readonly<{
  user: Readonly<{ id: string; email: string; display_name: string }>;
  token_type: string;
  access_token: string;
}>;

type OrganizationListResponse = Readonly<{
  organizations: readonly Readonly<{ id: string; role: string }>[];
}>;

type ProjectResponse = Readonly<{
  project: Readonly<{ id: string; organization_id: string; slug: string }>;
}>;

type ApiKeyResponse = Readonly<{
  api_key: Readonly<{ id: string }>;
  secret: string;
}>;

type EnrollmentResponse = Readonly<{
  enrollment: Readonly<{ id: string; project_id: string }>;
  enrollment_token: string;
}>;

type WorkerResponse = Readonly<{
  worker: Readonly<{ id: string; project_id: string; status: string }>;
}>;

type ChallengeResponse = Readonly<{
  challenge: Readonly<{
    worker_id: string;
    challenge: string;
    signing_payload: string;
  }>;
}>;

type SessionResponse = Readonly<{
  session: Readonly<{ token: string; expires_at: string }>;
}>;

async function jsonBody<Body>(response: Response): Promise<Body> {
  return await response.json() as Body;
}

describeWithPostgres("empty-database control-plane bootstrap", () => {
  const databaseName = `diaoyan_bootstrap_test_${randomUUID().replaceAll("-", "")}`;
  let administrator: Pool | undefined;
  let inspectionPool: Pool | undefined;
  let runtime: ControlPlaneRuntime | undefined;

  beforeAll(async () => {
    administrator = new Pool({ connectionString: requiredDatabaseUrl(), max: 1 });
    await administrator.query(`CREATE DATABASE ${quotedTestDatabase(databaseName)}`);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      await runtime?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await inspectionPool?.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (administrator !== undefined) {
      try {
        await administrator.query(`DROP DATABASE IF EXISTS ${quotedTestDatabase(databaseName)}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await administrator.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Bootstrap E2E resources failed to close.");
    }
  });

  it("migrates, provisions a human Project, and authenticates an enrolled Worker", async () => {
    const issuer = "https://identity.bootstrap.example";
    const authorizationEndpoint = `${issuer}/authorize`;
    const tokenEndpoint = `${issuer}/token`;
    const clientId = "bootstrap-e2e";
    const redirectUri = "https://app.bootstrap.example/v1/auth/oidc/callback";
    const providerKeys = await generateKeyPair("EdDSA");
    const humanKeys = await generateKeyPair("EdDSA");
    const sessionKeys = await generateKeyPair("EdDSA");
    const originalFetch = globalThis.fetch;
    let providerNonce: string | null = null;
    let authorizationCodeChallenge: string | null = null;
    let tokenRequest: TokenRequest | null = null;

    const controlledFetch: typeof fetch = async (input, init) => {
      const requestedUrl = input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? input
          : new URL(input);
      if (requestedUrl.toString() !== tokenEndpoint) return originalFetch(input, init);
      if (providerNonce === null) throw new Error("The OIDC nonce was not captured before exchange.");
      const form = new URLSearchParams(String(init?.body ?? ""));
      tokenRequest = Object.freeze({
        method: init?.method,
        headers: new Headers(init?.headers),
        form,
      });
      const issuedAt = Math.floor(Date.now() / 1_000);
      const idToken = await new SignJWT({
        nonce: providerNonce,
        email: "bootstrap@example.test",
        name: "Bootstrap User",
      })
        .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject("bootstrap-subject")
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .sign(providerKeys.privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    globalThis.fetch = controlledFetch;
    try {
      runtime = await startControlPlaneRuntime({
        database: { connectionString: databaseUrl(databaseName), max: 4 },
        humanIdentity: {
          issuer,
          authorizationEndpoint,
          tokenEndpoint,
          clientId,
          redirectUri,
          idTokenAlgorithms: ["EdDSA"],
          idTokenVerificationKey: providerKeys.publicKey,
          accessTokenIssuer: "https://control.bootstrap.example",
          accessTokenAudience: "bootstrap-human",
          accessTokenPrivateKey: humanKeys.privateKey,
          accessTokenPublicKey: humanKeys.publicKey,
        },
        identity: {
          sessionTokenIssuer: "https://control.bootstrap.example",
          sessionTokenAudience: "bootstrap-worker",
          sessionTokenPrivateKey: sessionKeys.privateKey,
          sessionTokenPublicKey: sessionKeys.publicKey,
        },
        listener: { host: "127.0.0.1", port: 0, tls: null },
      });
      inspectionPool = new Pool({ connectionString: databaseUrl(databaseName), max: 1 });

      const begin = await fetch(`${runtime.origin}/v1/auth/oidc/begin`, {
        redirect: "manual",
      });
      expect(begin.status).toBe(302);
      expect(begin.headers.get("cache-control")).toBe("no-store");
      const authorizationUrl = new URL(begin.headers.get("location") ?? "");
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(authorizationEndpoint);
      expect([...authorizationUrl.searchParams.keys()].sort()).toEqual([
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "nonce",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ]);
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("client_id")).toBe(clientId);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(authorizationUrl.searchParams.get("scope")).toBe("openid profile email");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      const state = authorizationUrl.searchParams.get("state");
      providerNonce = authorizationUrl.searchParams.get("nonce");
      authorizationCodeChallenge = authorizationUrl.searchParams.get("code_challenge");
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(providerNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(authorizationCodeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const beginCookie = begin.headers.get("set-cookie");
      expect(beginCookie).toContain(
        `__Secure-diaoyan_oidc_state=${state}; Path=/v1/auth/oidc/callback;`,
      );
      expect(beginCookie).toContain("Secure; HttpOnly; SameSite=Lax");
      const stateCookie = beginCookie?.split(";", 1)[0];
      if (state === null || stateCookie === undefined) {
        throw new Error("OIDC begin did not return state browser binding material.");
      }

      const callback = await fetch(
        `${runtime.origin}/v1/auth/oidc/callback?state=${state}&code=bootstrap-code`,
        { headers: { cookie: stateCookie } },
      );
      expect(callback.status).toBe(200);
      expect(callback.headers.get("cache-control")).toBe("no-store");
      const callbackCookies = callback.headers.get("set-cookie");
      expect(callbackCookies).toContain(
        "__Secure-diaoyan_oidc_state=; Path=/v1/auth/oidc/callback; Max-Age=0;",
      );
      expect(callbackCookies).toContain(
        "__Secure-diaoyan_refresh=dya_rt_",
      );
      expect(callbackCookies).toContain(
        "Path=/v1/auth/refresh;",
      );
      expect(callbackCookies).toContain("Secure; HttpOnly; SameSite=Strict");
      const login = await jsonBody<LoginResponse>(callback);
      expect(login).toMatchObject({
        user: {
          email: "bootstrap@example.test",
          display_name: "Bootstrap User",
        },
        token_type: "Bearer",
      });
      expect(login.access_token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);

      const observedTokenRequest = tokenRequest as TokenRequest | null;
      if (observedTokenRequest === null || authorizationCodeChallenge === null) {
        throw new Error("The OIDC token exchange was not observed.");
      }
      expect(observedTokenRequest.method).toBe("POST");
      expect(observedTokenRequest.headers.get("content-type"))
        .toBe("application/x-www-form-urlencoded");
      expect(observedTokenRequest.headers.get("authorization")).toBeNull();
      expect([...observedTokenRequest.form.entries()]).toEqual([
        ["grant_type", "authorization_code"],
        ["code", "bootstrap-code"],
        ["redirect_uri", redirectUri],
        ["client_id", clientId],
        ["code_verifier", expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)],
      ]);
      const codeVerifier = observedTokenRequest.form.get("code_verifier");
      if (codeVerifier === null) throw new Error("OIDC token exchange omitted code_verifier.");
      expect(createHash("sha256").update(codeVerifier).digest("base64url"))
        .toBe(authorizationCodeChallenge);

      const humanHeaders = { authorization: `Bearer ${login.access_token}` };
      const organizationsResponse = await fetch(`${runtime.origin}/v1/organizations`, {
        headers: humanHeaders,
      });
      expect(organizationsResponse.status).toBe(200);
      expect(organizationsResponse.headers.get("cache-control")).toBe("no-store");
      const organizations = await jsonBody<OrganizationListResponse>(organizationsResponse);
      expect(organizations.organizations).toHaveLength(1);
      expect(organizations.organizations[0]?.role).toBe("owner");
      const organizationId = organizations.organizations[0]?.id;
      if (organizationId === undefined) throw new Error("OIDC provisioning created no Organization.");

      const projectResponse = await fetch(
        `${runtime.origin}/v1/organizations/${organizationId}/projects`,
        {
          method: "POST",
          headers: {
            ...humanHeaders,
            "content-type": "application/json",
            "idempotency-key": "bootstrap-project",
          },
          body: JSON.stringify({ slug: "bootstrap", name: "Bootstrap" }),
        },
      );
      expect(projectResponse.status).toBe(201);
      expect(projectResponse.headers.get("cache-control")).toBe("no-store");
      const project = await jsonBody<ProjectResponse>(projectResponse);
      expect(project.project).toMatchObject({ organization_id: organizationId, slug: "bootstrap" });

      const keyResponse = await fetch(
        `${runtime.origin}/v1/projects/${project.project.id}/api-keys`,
        {
          method: "POST",
          headers: { ...humanHeaders, "content-type": "application/json" },
          body: JSON.stringify({ scopes: ["tasks:write"], expires_at: null }),
        },
      );
      expect(keyResponse.status).toBe(201);
      expect(keyResponse.headers.get("cache-control")).toBe("no-store");
      const apiKey = await jsonBody<ApiKeyResponse>(keyResponse);
      expect(apiKey.secret).toMatch(/^dya_live_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/u);

      const keyListResponse = await fetch(
        `${runtime.origin}/v1/projects/${project.project.id}/api-keys`,
        { headers: humanHeaders },
      );
      expect(keyListResponse.status).toBe(200);
      const keyListText = await keyListResponse.text();
      expect(keyListText).not.toContain(apiKey.secret);
      expect(JSON.parse(keyListText)).not.toHaveProperty("secret");

      const enrollmentResponse = await fetch(
        `${runtime.origin}/v1/projects/${project.project.id}/worker-enrollments`,
        {
          method: "POST",
          headers: { ...humanHeaders, "content-type": "application/json" },
          body: JSON.stringify({ worker_name: "bootstrap-worker" }),
        },
      );
      expect(enrollmentResponse.status).toBe(201);
      expect(enrollmentResponse.headers.get("cache-control")).toBe("no-store");
      const enrollment = await jsonBody<EnrollmentResponse>(enrollmentResponse);
      expect(enrollment.enrollment.project_id).toBe(project.project.id);

      const workerKeys = generateKeyPairSync("ed25519");
      const publicKeySpki = workerKeys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url");
      const workerResponse = await fetch(`${runtime.origin}/v1/worker-enrollments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${enrollment.enrollment_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          public_key_spki: publicKeySpki,
          version: "1.0.0",
          capabilities: { http: true },
        }),
      });
      expect(workerResponse.status).toBe(201);
      const worker = await jsonBody<WorkerResponse>(workerResponse);
      expect(worker.worker).toMatchObject({ project_id: project.project.id, status: "active" });

      const challengeResponse = await fetch(
        `${runtime.origin}/v1/worker-sessions/challenges`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worker_id: worker.worker.id }),
        },
      );
      expect(challengeResponse.status).toBe(201);
      const challenge = await jsonBody<ChallengeResponse>(challengeResponse);
      expect(challenge.challenge.worker_id).toBe(worker.worker.id);
      expect(challenge.challenge.signing_payload)
        .toBe(`dya-worker-session-v1\n${challenge.challenge.challenge}`);
      const signature = signMessage(
        null,
        Buffer.from(challenge.challenge.signing_payload),
        workerKeys.privateKey,
      ).toString("base64url");

      const sessionResponse = await fetch(`${runtime.origin}/v1/worker-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worker_id: worker.worker.id,
          challenge: challenge.challenge.challenge,
          signature,
        }),
      });
      expect(sessionResponse.status).toBe(201);
      expect(sessionResponse.headers.get("cache-control")).toBe("no-store");
      const session = await jsonBody<SessionResponse>(sessionResponse);
      expect(session.session.token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);

      const claimResponse = await fetch(
        `${runtime.origin}/v1/workers/${worker.worker.id}/claims`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.session.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ wait_ms: 0 }),
        },
      );
      expect(claimResponse.status).toBe(204);
      expect(claimResponse.headers.get("cache-control")).toBe("no-store");
      expect(await claimResponse.text()).toBe("");

      const migrations = await inspectionPool.query<{ count: number; version: number }>(`
        SELECT count(*)::integer AS count, max(version)::integer AS version
        FROM control_plane_schema_migrations
      `);
      expect(migrations.rows[0]).toEqual({ count: 9, version: 9 });
      const storedKey = await inspectionPool.query<{ key_hash: Buffer; project_id: string }>(`
        SELECT key_hash, project_id FROM api_keys WHERE id = $1
      `, [apiKey.api_key.id]);
      expect(storedKey.rows[0]?.project_id).toBe(project.project.id);
      expect(storedKey.rows[0]?.key_hash)
        .toEqual(createHash("sha256").update(apiKey.secret).digest());
      const storedEnrollment = await inspectionPool.query<{ token_hash: Buffer }>(`
        SELECT token_hash FROM worker_enrollments WHERE id = $1
      `, [enrollment.enrollment.id]);
      expect(storedEnrollment.rows[0]?.token_hash)
        .toEqual(createHash("sha256").update(enrollment.enrollment_token).digest());
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 20_000);
});
