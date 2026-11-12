#!/usr/bin/env node

import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
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
import { withHealthChecks } from "./control-plane/health.js";
import { HumanAuthHttpApi } from "./control-plane/human-auth-http-api.js";
import { assertEd25519KeyPair } from "./control-plane/ed25519-key-pair.js";
import {
  JobResultService,
  listProjectAuditEvents,
} from "./control-plane/organization-authorization.js";
import { WorkerHttpApi } from "./control-plane/organization-service.js";
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
} from "./control-plane/project-scope.js";
import {
  runControlPlaneMigrations,
} from "./control-plane/migrations.js";
import {
  ControlPlaneJobLeaseSweeper,
  ControlPlaneJobLeaseSweepRunner,
} from "./control-plane/job-lease-recovery.js";
import {
  ArtifactRetentionSweeper,
  ArtifactStorageService,
  artifactObjectStoreFromEnvironment,
  artifactRetentionDaysFromEnvironment,
  type ArtifactObjectStore,
} from "./control-plane/artifact-storage.js";
import {
  BillingService,
  billingPriceTableFromEnvironment,
  type BillingPriceTable,
} from "./control-plane/billing.js";
import { BillingHttpApi } from "./control-plane/billing-http-api.js";
import {
  StripeClient,
  stripeConfigFromEnvironment,
  type StripeConfig,
} from "./control-plane/stripe.js";
import {
  ApiRequestRateLimiter,
  projectQuotasFromEnvironment,
  unlimitedProjectQuotas,
  type ProjectQuotaLimits,
} from "./control-plane/quotas.js";
import {
  WebhookDispatcher,
  WebhookSecretCipher,
  WebhookService,
} from "./control-plane/webhooks.js";
import { WorkerBootstrapHttpApi } from "./control-plane/worker-bootstrap-http-api.js";
import { logEvent } from "./log.js";
import { ControlPlaneMetrics } from "./control-plane/control-metrics.js";
import { PostgresControlPlaneDatabase } from "./control-plane/postgres-database.js";
import {
  startWorkerControlServer,
  type WorkerControlListener,
  type WorkerControlServerConfig,
} from "./control-plane/http-listener.js";
import { UrlPolicy } from "./security/url-policy.js";
import { createMcpServer } from "./mcp.js";
import {
  metricsListenerFromEnvironment,
  startMetricsListener,
  type MetricsListener,
  type MetricsListenerConfig,
} from "./metrics-server.js";

const jobLeaseSweepIntervalMs = 30_000;
const webhookDeliveryIntervalMs = 1_000;
const artifactRetentionIntervalMs = 60 * 60 * 1_000;

export { PostgresControlPlaneDatabase };
export {
  startWorkerControlServer,
  type WorkerControlListener,
  type WorkerControlServerConfig,
} from "./control-plane/http-listener.js";

export type ControlPlaneRuntimeConfig = Readonly<{
  database: PoolConfig;
  humanIdentity: OidcSessionConfig;
  identity: WorkerIdentityConfig;
  listener: WorkerControlServerConfig;
  quotas?: ProjectQuotaLimits;
  webhookCipher?: WebhookSecretCipher | null;
  artifactStore?: ArtifactObjectStore | null;
  artifactRetentionDays?: number | null;
  metrics?: MetricsListenerConfig | null;
  billingPrices?: BillingPriceTable | null;
  stripe?: StripeConfig | null;
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
    webhookCipher: environment.DIAOYAN_WEBHOOK_ENCRYPTION_KEY_PATH === undefined
      ? null
      : await WebhookSecretCipher.fromFile(environment.DIAOYAN_WEBHOOK_ENCRYPTION_KEY_PATH),
    artifactStore: artifactObjectStoreFromEnvironment(environment),
    artifactRetentionDays: artifactRetentionDaysFromEnvironment(environment),
    metrics: metricsListenerFromEnvironment(environment),
    billingPrices: await billingPriceTableFromEnvironment(environment),
    stripe: stripeConfigFromEnvironment(environment),
  });
}

export async function startControlPlaneRuntime(
  config: ControlPlaneRuntimeConfig,
): Promise<ControlPlaneRuntime> {
  const database = new PostgresControlPlaneDatabase(new Pool(config.database));
  let sweepRunner: ControlPlaneJobLeaseSweepRunner | undefined;
  let webhookRunner: ControlPlaneJobLeaseSweepRunner | undefined;
  let retentionRunner: ControlPlaneJobLeaseSweepRunner | undefined;
  let listener: WorkerControlListener | undefined;
  let controlMetricsListener: MetricsListener | undefined;
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
    const webhookCipher = config.webhookCipher ?? null;
    const webhookUrlPolicy = new UrlPolicy();
    if (webhookCipher !== null) {
      webhookRunner = new ControlPlaneJobLeaseSweepRunner(
        new WebhookDispatcher(database, webhookCipher, webhookUrlPolicy),
        {
          intervalMs: webhookDeliveryIntervalMs,
          onFatalError: (error) => {
            if (runtimeReady) rejectFinished(error);
            else {
              pendingFatalError = error;
              hasPendingFatalError = true;
            }
          },
        },
      );
      await webhookRunner.start();
      if (hasPendingFatalError) throw pendingFatalError;
    }
    const webhooks = new WebhookService(database, webhookCipher, webhookUrlPolicy);
    const artifacts = new ArtifactStorageService(database, config.artifactStore ?? null);
    if (config.artifactStore != null && config.artifactRetentionDays != null) {
      retentionRunner = new ControlPlaneJobLeaseSweepRunner(
        new ArtifactRetentionSweeper(database, config.artifactStore, config.artifactRetentionDays),
        {
          intervalMs: artifactRetentionIntervalMs,
          onFatalError: (error) => {
            if (runtimeReady) rejectFinished(error);
            else {
              pendingFatalError = error;
              hasPendingFatalError = true;
            }
          },
        },
      );
      await retentionRunner.start();
      if (hasPendingFatalError) throw pendingFatalError;
    }
    const identity = new WorkerIdentityService(database, config.identity);
    const humanIdentity = new OidcSessionService(database, config.humanIdentity);
    const quotas = config.quotas ?? unlimitedProjectQuotas;
    const billing = new BillingService(database, {
      prices: config.billingPrices ?? null,
      stripe: config.stripe == null ? null : new StripeClient(config.stripe),
    });
    const jobs = new ControlPlaneJobService(database, { quotas, billing });
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
      webhooks,
      artifacts,
      projectUsage: billing.projectUsage.bind(billing),
    }, quotas.apiRequestsPerMinute === null
      ? {}
      : { rateLimiter: new ApiRequestRateLimiter(quotas.apiRequestsPerMinute) });
    const workerApi = new WorkerHttpApi({ identity, jobs, results, artifacts });
    const controlMetrics = new ControlPlaneMetrics(database);
    listener = await startWorkerControlServer(
      withHealthChecks(
        controlMetrics.instrument(
          new ControlPlaneHttpApi(
            humanAuthApi, projectAdminApi, workerBootstrapApi, projectApi, workerApi,
            new BillingHttpApi({
              authenticateAccessToken: humanIdentity.verifyAccessToken.bind(humanIdentity),
              billing,
            }),
          ),
        ),
        database,
      ),
      config.listener,
    );
    if (config.metrics != null) {
      controlMetricsListener = await startMetricsListener(controlMetrics, config.metrics);
      logEvent("info", "metrics.listening", { origin: controlMetricsListener.origin });
    }
    const activeListener = listener;
    if (hasPendingFatalError) throw pendingFatalError;
    runtimeReady = true;
    void activeListener.failure.catch((error: unknown) => rejectFinished(error));
    let closePromise: Promise<void> | undefined;
    const closeResources = async (): Promise<void> => {
      const errors: unknown[] = [];
      for (const close of [
        () => activeListener.close(),
        () => controlMetricsListener?.close(),
        () => webhookRunner?.close(),
        () => retentionRunner?.close(),
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
    for (const openListener of [listener, controlMetricsListener]) {
      try {
        await openListener?.close();
      } catch (listenerCloseError) {
        cleanupErrors.push(listenerCloseError);
      }
    }
    for (const runner of [webhookRunner, retentionRunner]) {
      try {
        await runner?.close();
      } catch (runnerCloseError) {
        cleanupErrors.push(runnerCloseError);
      }
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
