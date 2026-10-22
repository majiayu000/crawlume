#!/usr/bin/env node

import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { exportSPKI, importPKCS8, importSPKI } from "jose";
import { Pool, type PoolConfig } from "pg";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  authenticateProjectApiKey,
  createProjectApiKey,
  revokeProjectApiKey,
  WorkerIdentityService,
  type WorkerIdentityConfig,
} from "./control-plane/api-key-service.js";
import { HumanAuthHttpApi } from "./control-plane/human-auth-http-api.js";
import { assertEd25519KeyPair } from "./control-plane/ed25519-key-pair.js";
import {
  JobResultService,
  listProjectAuditEvents,
} from "./control-plane/organization-authorization.js";
import { WorkerHttpApi, type WorkerHttpResponse } from "./control-plane/organization-service.js";
import {
  createOidcRemoteJwkSet,
  OidcSessionService,
  type OidcIdTokenAlgorithm,
  type OidcSessionConfig,
} from "./control-plane/oidc-session-service.js";
import {
  createOrganizationProject,
  listOrganizationProjects,
  listOrganizations,
} from "./control-plane/project-admin-management.js";
import { ProjectAdminHttpApi } from "./control-plane/project-admin-http-api.js";
import { ProjectApiKeyHttpApi } from "./control-plane/project-api-key-http-api.js";
import { listProjectApiKeys } from "./control-plane/project-api-key-management.js";
import { ControlPlaneHttpApi, ProjectJobHttpApi } from "./control-plane/project-http-api.js";
import {
  ControlPlaneJobService,
  resolveProjectScope,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
} from "./control-plane/project-scope.js";
import {
  runControlPlaneMigrations,
  type ControlPlaneMigrationClient,
} from "./control-plane/migrations.js";
import {
  ControlPlaneJobLeaseSweeper,
  ControlPlaneJobLeaseSweepRunner,
} from "./control-plane/job-lease-recovery.js";
import {
  ApiRequestRateLimiter,
  projectQuotasFromEnvironment,
  unlimitedProjectQuotas,
  type ProjectQuotaLimits,
} from "./control-plane/quotas.js";
import { WorkerBootstrapHttpApi } from "./control-plane/worker-bootstrap-http-api.js";
import { logEvent } from "./log.js";
import { createMcpServer } from "./mcp.js";
import {
  metricsListenerFromEnvironment,
  startMetricsListener,
  type MetricsListener,
} from "./metrics-server.js";

const workerBodyLimitBytes = 64 * 1024;
const workerHeaderLimitBytes = 16 * 1024;
const workerReceiveTimeoutMs = 10_000;
const jobLeaseSweepIntervalMs = 30_000;
const controlPlaneQueryPath = /^(?:\/v1\/auth\/oidc\/callback|\/v1\/organizations|\/v1\/organizations\/[^/]+\/projects|\/v1\/projects\/[^/]+\/(?:api-keys|jobs\/[^/]+\/publications|audit-events))$/u;

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

export class PostgresControlPlaneDatabase implements ControlPlaneDatabase {
  constructor(private readonly pool: Pool) {
    pool.on("error", () => {
      logEvent("warn", "control_plane.postgres.idle_connection_discarded");
    });
  }

  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<{ rows: Row[] }> {
    const result = await this.pool.query(statement, [...parameters]);
    return { rows: result.rows as Row[] };
  }

  async connect(): Promise<ControlPlaneMigrationClient> {
    const client = await this.pool.connect();
    return {
      query: async <Row>(statement: string, parameters: readonly unknown[] = []) => {
        const result = await client.query(statement, [...parameters]);
        return { rows: result.rows as Row[] };
      },
      release: (error?: Error | true) => client.release(error),
    };
  }

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let began = false;
    let releaseError: Error | true | undefined;
    try {
      await client.query("BEGIN");
      began = true;
      const transaction: ControlPlaneQuery = {
        query: async <Row>(statement: string, parameters: readonly unknown[]) => {
          const result = await client.query(statement, [...parameters]);
          return { rows: result.rows as Row[] };
        },
      };
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : true;
          throw new AggregateError(
            [error, rollbackError],
            "The control-plane transaction and rollback both failed.",
          );
        }
      }
      throw error;
    } finally {
      if (releaseError === undefined) {
        client.release();
      } else {
        client.release(releaseError);
      }
    }
  }

  async assertReady(): Promise<void> {
    await this.query("SELECT 1", []);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export type ControlPlaneRuntimeConfig = Readonly<{
  database: PoolConfig;
  humanIdentity: OidcSessionConfig;
  identity: WorkerIdentityConfig;
  listener: WorkerControlServerConfig;
  quotas?: ProjectQuotaLimits;
}>;

export type ControlPlaneRuntime = Readonly<{
  origin: string;
  finished: Promise<void>;
  close(): Promise<void>;
}>;

function requiredRuntimeValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function readRuntimeFile(path: string, name: string, privateFile: boolean): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${name} could not be opened as a regular non-symlink file.`, { cause: error });
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${name} must be a regular file.`);
    if (privateFile && (metadata.mode & 0o077) !== 0) {
      throw new Error(`${name} must not grant permissions to group or other users.`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function controlPlanePoolConfig(
  environment: NodeJS.ProcessEnv,
): Promise<PoolConfig> {
  const connectionString = requiredRuntimeValue(environment, "DIAOYAN_CONTROL_DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch (error) {
    throw new Error("DIAOYAN_CONTROL_DATABASE_URL must be a PostgreSQL URL.", { cause: error });
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DIAOYAN_CONTROL_DATABASE_URL must use postgres or postgresql.");
  }
  for (const option of ["sslcert", "sslkey", "sslrootcert", "sslmode"] as const) {
    if (parsed.searchParams.has(option)) {
      throw new Error(
        `DIAOYAN_CONTROL_DATABASE_URL must not contain ${option}; TLS is configured by the runtime.`,
      );
    }
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  const loopback = hostname === "127.0.0.1" || hostname === "::1";
  const caPath = environment.DIAOYAN_CONTROL_DATABASE_CA_PATH;
  const ca = caPath === undefined ? undefined
    : await readRuntimeFile(caPath, "DIAOYAN_CONTROL_DATABASE_CA_PATH", false);
  return {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    enableChannelBinding: true,
    ssl: loopback && ca === undefined ? false : {
      rejectUnauthorized: true,
      ...(ca === undefined ? {} : { ca }),
    },
  };
}

function controlPlanePort(environment: NodeJS.ProcessEnv): number {
  const value = environment.DIAOYAN_CONTROL_PORT ?? "8787";
  if (!/^(0|[1-9][0-9]{0,4})$/u.test(value)) {
    throw new Error("DIAOYAN_CONTROL_PORT must be an integer from 0 to 65535.");
  }
  const port = Number(value);
  if (port > 65_535) throw new Error("DIAOYAN_CONTROL_PORT must be an integer from 0 to 65535.");
  return port;
}

function oidcIdTokenAlgorithm(environment: NodeJS.ProcessEnv): OidcIdTokenAlgorithm {
  const value = requiredRuntimeValue(environment, "DIAOYAN_OIDC_ID_TOKEN_ALGORITHM");
  if (value !== "RS256" && value !== "PS256" && value !== "ES256" && value !== "EdDSA") {
    throw new Error("DIAOYAN_OIDC_ID_TOKEN_ALGORITHM is unsupported.");
  }
  return value;
}

export async function loadControlPlaneRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ControlPlaneRuntimeConfig> {
  const privateKeyPem = await readRuntimeFile(
    requiredRuntimeValue(environment, "DIAOYAN_WORKER_SESSION_PRIVATE_KEY_PATH"),
    "DIAOYAN_WORKER_SESSION_PRIVATE_KEY_PATH",
    true,
  );
  const publicKeyPem = await readRuntimeFile(
    requiredRuntimeValue(environment, "DIAOYAN_WORKER_SESSION_PUBLIC_KEY_PATH"),
    "DIAOYAN_WORKER_SESSION_PUBLIC_KEY_PATH",
    false,
  );
  const humanPrivateKeyPem = await readRuntimeFile(
    requiredRuntimeValue(environment, "DIAOYAN_HUMAN_ACCESS_TOKEN_PRIVATE_KEY_PATH"),
    "DIAOYAN_HUMAN_ACCESS_TOKEN_PRIVATE_KEY_PATH", true,
  );
  const humanPublicKeyPem = await readRuntimeFile(
    requiredRuntimeValue(environment, "DIAOYAN_HUMAN_ACCESS_TOKEN_PUBLIC_KEY_PATH"),
    "DIAOYAN_HUMAN_ACCESS_TOKEN_PUBLIC_KEY_PATH", false,
  );
  const workerPrivateKey = await importPKCS8(privateKeyPem, "EdDSA");
  const workerPublicKey = await importSPKI(publicKeyPem, "EdDSA");
  const humanPrivateKey = await importPKCS8(humanPrivateKeyPem, "EdDSA");
  const humanPublicKey = await importSPKI(humanPublicKeyPem, "EdDSA");
  await assertEd25519KeyPair(workerPrivateKey, workerPublicKey, "Worker session signing");
  await assertEd25519KeyPair(humanPrivateKey, humanPublicKey, "Human access-token signing");
  if (await exportSPKI(workerPublicKey) === await exportSPKI(humanPublicKey)) {
    throw new Error("Human access-token and Worker session signing public keys must be distinct.");
  }
  const tlsKeyPath = environment.DIAOYAN_CONTROL_TLS_KEY_PATH;
  const tlsCertPath = environment.DIAOYAN_CONTROL_TLS_CERT_PATH;
  if ((tlsKeyPath === undefined) !== (tlsCertPath === undefined)) {
    throw new Error("DIAOYAN_CONTROL_TLS_KEY_PATH and DIAOYAN_CONTROL_TLS_CERT_PATH are required together.");
  }
  const tls = tlsKeyPath === undefined || tlsCertPath === undefined ? null : {
    key: await readRuntimeFile(tlsKeyPath, "DIAOYAN_CONTROL_TLS_KEY_PATH", true),
    cert: await readRuntimeFile(tlsCertPath, "DIAOYAN_CONTROL_TLS_CERT_PATH", false),
  };
  return Object.freeze({
    database: await controlPlanePoolConfig(environment),
    humanIdentity: {
      issuer: requiredRuntimeValue(environment, "DIAOYAN_OIDC_ISSUER"),
      authorizationEndpoint: requiredRuntimeValue(environment, "DIAOYAN_OIDC_AUTHORIZATION_ENDPOINT"),
      tokenEndpoint: requiredRuntimeValue(environment, "DIAOYAN_OIDC_TOKEN_ENDPOINT"),
      clientId: requiredRuntimeValue(environment, "DIAOYAN_OIDC_CLIENT_ID"),
      redirectUri: requiredRuntimeValue(environment, "DIAOYAN_OIDC_REDIRECT_URI"),
      idTokenAlgorithms: [oidcIdTokenAlgorithm(environment)],
      idTokenVerificationKey: createOidcRemoteJwkSet(
        requiredRuntimeValue(environment, "DIAOYAN_OIDC_JWKS_URI"),
      ),
      accessTokenIssuer: requiredRuntimeValue(environment, "DIAOYAN_HUMAN_ACCESS_TOKEN_ISSUER"),
      accessTokenAudience: requiredRuntimeValue(environment, "DIAOYAN_HUMAN_ACCESS_TOKEN_AUDIENCE"),
      accessTokenPrivateKey: humanPrivateKey,
      accessTokenPublicKey: humanPublicKey,
    },
    identity: {
      sessionTokenIssuer: requiredRuntimeValue(environment, "DIAOYAN_WORKER_SESSION_ISSUER"),
      sessionTokenAudience: requiredRuntimeValue(environment, "DIAOYAN_WORKER_SESSION_AUDIENCE"),
      sessionTokenPrivateKey: workerPrivateKey,
      sessionTokenPublicKey: workerPublicKey,
    },
    listener: {
      host: environment.DIAOYAN_CONTROL_HOST ?? "127.0.0.1",
      port: controlPlanePort(environment),
      tls,
    },
    quotas: projectQuotasFromEnvironment(environment),
  });
}

export async function startControlPlaneRuntime(
  config: ControlPlaneRuntimeConfig,
): Promise<ControlPlaneRuntime> {
  const database = new PostgresControlPlaneDatabase(new Pool(config.database));
  let sweepRunner: ControlPlaneJobLeaseSweepRunner | undefined;
  let listener: WorkerControlListener | undefined;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  void finished.catch(() => undefined);
  try {
    await runControlPlaneMigrations(database);
    await database.assertReady();
    let pendingFatalError: unknown;
    let hasPendingFatalError = false;
    let runtimeReady = false;
    sweepRunner = new ControlPlaneJobLeaseSweepRunner(
      new ControlPlaneJobLeaseSweeper(database),
      {
        intervalMs: jobLeaseSweepIntervalMs,
        onFatalError: (error) => {
          if (runtimeReady) rejectFinished(error);
          else {
            pendingFatalError = error;
            hasPendingFatalError = true;
          }
        },
      },
    );
    await sweepRunner.start();
    if (hasPendingFatalError) throw pendingFatalError;
    const identity = new WorkerIdentityService(database, config.identity);
    const humanIdentity = new OidcSessionService(database, config.humanIdentity);
    const quotas = config.quotas ?? unlimitedProjectQuotas;
    const jobs = new ControlPlaneJobService(database, { quotas });
    const results = new JobResultService(database);
    const humanAuthApi = new HumanAuthHttpApi({
      beginLogin: humanIdentity.beginLogin.bind(humanIdentity),
      completeLogin: humanIdentity.completeLogin.bind(humanIdentity),
      rotateRefreshToken: humanIdentity.rotateRefreshToken.bind(humanIdentity),
      verifyAccessToken: humanIdentity.verifyAccessToken.bind(humanIdentity),
      revokeAllUserSessions: humanIdentity.revokeAllUserSessions.bind(humanIdentity),
    });
    const projectApiKeyApi = new ProjectApiKeyHttpApi({
      authenticateAccessToken: humanIdentity.verifyAccessToken.bind(humanIdentity),
      resolveScope: (subject, projectId) => resolveProjectScope(database, subject, projectId),
      create: (scope, input, context) => createProjectApiKey(database, scope, input, context),
      list: (scope, input) => listProjectApiKeys(database, scope, input),
      revoke: (scope, keyId, context) => revokeProjectApiKey(database, scope, keyId, context),
    });
    const projectAdminApi = new ProjectAdminHttpApi({
      authenticateAccessToken: humanIdentity.verifyAccessToken.bind(humanIdentity),
      listOrganizations: (subject, input) => listOrganizations(database, subject, input),
      listProjects: (subject, organizationId, input) =>
        listOrganizationProjects(database, subject, organizationId, input),
      createProject: (subject, organizationId, key, input, context) =>
        createOrganizationProject(database, subject, organizationId, key, input, context),
    }, projectApiKeyApi);
    const workerBootstrapApi = new WorkerBootstrapHttpApi({
      authenticateAccessToken: humanIdentity.verifyAccessToken.bind(humanIdentity),
      resolveScope: (subject, projectId) => resolveProjectScope(database, subject, projectId),
      createEnrollment: identity.createEnrollment.bind(identity),
      enroll: identity.enroll.bind(identity),
      createChallenge: identity.createChallenge.bind(identity),
      createSession: identity.createSession.bind(identity),
      disableWorker: identity.disableWorker.bind(identity),
    });
    const projectApi = new ProjectJobHttpApi({
      authenticate: (rawKey, context) => authenticateProjectApiKey(database, rawKey, context),
      createJob: jobs.createJob.bind(jobs),
      getJob: jobs.getJob.bind(jobs),
      pauseJob: jobs.pause.bind(jobs),
      resumeJob: jobs.resume.bind(jobs),
      cancelJob: jobs.cancel.bind(jobs),
      listPublications: results.listPublications.bind(results),
      listAuditEvents: (scope, input) => listProjectAuditEvents(database, scope, input),
    }, quotas.apiRequestsPerMinute === null
      ? {}
      : { rateLimiter: new ApiRequestRateLimiter(quotas.apiRequestsPerMinute) });
    const workerApi = new WorkerHttpApi({ identity, jobs, results });
    listener = await startWorkerControlServer(
      new ControlPlaneHttpApi(humanAuthApi, projectAdminApi, workerBootstrapApi, projectApi, workerApi),
      config.listener,
    );
    const activeListener = listener;
    if (hasPendingFatalError) throw pendingFatalError;
    runtimeReady = true;
    void activeListener.failure.catch((error: unknown) => rejectFinished(error));
    let closePromise: Promise<void> | undefined;
    const closeResources = async (): Promise<void> => {
      const errors: unknown[] = [];
      for (const close of [
        () => activeListener.close(),
        () => sweepRunner?.close(),
        () => database.close(),
      ]) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Control-plane runtime resources failed to close.");
      }
    };
    return Object.freeze({
      origin: activeListener.origin,
      finished,
      close: () => {
        closePromise ??= closeResources().then(resolveFinished, (error: unknown) => {
          rejectFinished(error);
          throw error;
        });
        return closePromise;
      },
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await listener?.close();
    } catch (listenerCloseError) {
      cleanupErrors.push(listenerCloseError);
    }
    try {
      await sweepRunner?.close();
    } catch (sweepCloseError) {
      cleanupErrors.push(sweepCloseError);
    }
    try {
      await database.close();
    } catch (databaseCloseError) {
      cleanupErrors.push(databaseCloseError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Control-plane startup and resource cleanup both failed.",
      );
    }
    throw error;
  }
}

export async function controlPlaneMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = await startControlPlaneRuntime(await loadControlPlaneRuntimeConfig(environment));
  logEvent("info", "control_plane.listening", { origin: runtime.origin });
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  const closeForSignal = (): void => {
    void close().catch(() => undefined);
  };
  process.once("SIGINT", closeForSignal);
  process.once("SIGTERM", closeForSignal);
  let runtimeError: unknown;
  let hasRuntimeError = false;
  try {
    await runtime.finished;
  } catch (error) {
    runtimeError = error;
    hasRuntimeError = true;
  }
  try {
    process.off("SIGINT", closeForSignal);
    process.off("SIGTERM", closeForSignal);
    await close();
  } catch (closeError) {
    if (hasRuntimeError) {
      throw new AggregateError(
        [runtimeError, closeError],
        "The control-plane runtime and shutdown both failed.",
      );
    }
    throw closeError;
  }
  if (hasRuntimeError) throw runtimeError;
}

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const metricsConfig = metricsListenerFromEnvironment(environment);
  const app = createApp(loadConfig(), { runCrawlWorker: true });
  let metricsListener: MetricsListener | null = null;
  if (metricsConfig !== null) {
    try {
      metricsListener = await startMetricsListener(app.metrics, metricsConfig);
    } catch (error) {
      await app.close();
      throw error;
    }
    logEvent("info", "metrics.listening", { origin: metricsListener.origin });
  }
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    process.off("SIGINT", closeInBackground);
    process.off("SIGTERM", closeInBackground);
    process.stdin.off("end", closeInBackground);
    closePromise = (async () => {
      const errors: unknown[] = [];
      for (const operation of [
        () => metricsListener?.close(),
        () => server.close(),
        () => app.close(),
      ]) {
        try { await operation(); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, "MCP shutdown failed.");
    })();
    return closePromise;
  };
  const closeInBackground = (): void => {
    void close().catch((error: unknown) => {
      logEvent("error", "process.shutdown_failed", { error: String(error) });
      process.exitCode = 1;
    });
  };
  server.server.onclose = closeInBackground;
  process.once("SIGINT", closeInBackground);
  process.once("SIGTERM", closeInBackground);
  // StdioServerTransport does not forward stdin EOF to its onclose callback.
  process.stdin.once("end", closeInBackground);
  try {
    await server.connect(transport);
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "MCP connection and cleanup both failed.");
    }
    throw error;
  }
}

const entry = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entry !== "" && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const operation = process.argv[2] === "--control-plane" ? controlPlaneMain : main;
  operation().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const processName = operation === controlPlaneMain ? "crawlume-control-plane" : "crawlume-mcp";
    logEvent("error", "process.failed", { process: processName, error: message });
    process.exitCode = 1;
  });
}
