import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";

import { jwtVerify, SignJWT, type KeyInput } from "jose";

import {
  type AuditContext,
  authorizeOrganizationWrite,
  recordAuditEvent,
  type RecordAuditEventInput,
} from "./organization-authorization.js";
import type {
  ControlPlaneDatabase,
  ControlPlaneQuery,
  ProjectScope,
} from "./project-scope.js";
import {
  createBoundedWorkerChallenge,
  workerSigningPayload,
} from "./worker-challenge-budget.js";

export { WorkerChallengeRateLimitedError } from "./worker-challenge-budget.js";

export const projectApiKeyScopes = [
  "tasks:write",
  "results:read",
  "project:admin",
] as const;

export type ProjectApiKeyScope = (typeof projectApiKeyScopes)[number];

export type ProjectApiKeyMetadata = Readonly<{
  id: string;
  projectId: string;
  displayPrefix: string;
  createdByUserId: string;
  scopes: readonly ProjectApiKeyScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}>;

export type CreatedProjectApiKey = Readonly<{
  apiKey: ProjectApiKeyMetadata;
  rawKey: string;
}>;

export type AuthenticatedProjectApiKey = Readonly<{
  apiKeyId: string;
  projectId: string;
  organizationId: string;
  createdByUserId: string;
  scopes: readonly ProjectApiKeyScope[];
}>;

export type CreateProjectApiKeyInput = Readonly<{
  scopes: readonly ProjectApiKeyScope[];
  expiresAt: Date | null;
}>;

export type ProjectApiKeyDatabaseRow = {
  id: string;
  project_id: string;
  display_prefix: string;
  created_by_user_id: string;
  tasks_write: boolean;
  results_read: boolean;
  project_admin: boolean;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
};

type AuthenticatedApiKeyRow = Pick<
  ProjectApiKeyDatabaseRow,
  "id" | "project_id" | "created_by_user_id" |
  "tasks_write" | "results_read" | "project_admin"
> & { organization_id: string };

export class ProjectApiKeyAuthenticationError extends Error {
  readonly code = "API_KEY_INVALID";

  constructor() {
    super("The API key is invalid, expired, or revoked.");
    this.name = "ProjectApiKeyAuthenticationError";
  }
}

export class ProjectApiKeyScopeError extends Error {
  readonly code = "API_KEY_SCOPE_DENIED";

  constructor() {
    super("The API key does not grant the required scope.");
    this.name = "ProjectApiKeyScopeError";
  }
}

export class ProjectApiKeyNotFoundError extends Error {
  readonly code = "API_KEY_NOT_FOUND";

  constructor() {
    super("The API key does not exist in this project.");
    this.name = "ProjectApiKeyNotFoundError";
  }
}

function normalizeScopes(scopes: readonly ProjectApiKeyScope[]): ProjectApiKeyScope[] {
  const requested = new Set<string>(scopes);
  if (requested.size === 0) {
    throw new Error("At least one API key scope is required.");
  }
  for (const scope of requested) {
    if (!(projectApiKeyScopes as readonly string[]).includes(scope)) {
      throw new Error("An unsupported API key scope was requested.");
    }
  }
  return projectApiKeyScopes.filter((scope) => requested.has(scope));
}

function scopesFromRow(row: Pick<
  ProjectApiKeyDatabaseRow,
  "tasks_write" | "results_read" | "project_admin"
>): ProjectApiKeyScope[] {
  const scopes: ProjectApiKeyScope[] = [];
  if (row.tasks_write) scopes.push("tasks:write");
  if (row.results_read) scopes.push("results:read");
  if (row.project_admin) scopes.push("project:admin");
  return scopes;
}

export function projectApiKeyMetadataFromRow(
  row: ProjectApiKeyDatabaseRow,
): ProjectApiKeyMetadata {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    displayPrefix: row.display_prefix,
    createdByUserId: row.created_by_user_id,
    scopes: Object.freeze(scopesFromRow(row)),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  });
}

function hashApiKey(rawKey: string): Buffer {
  return createHash("sha256").update(rawKey).digest();
}

function requireApiKeyFormat(rawKey: string): void {
  if (!/^dya_live_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/u.test(rawKey)) {
    throw new ProjectApiKeyAuthenticationError();
  }
}

async function recordCredentialAudit(
  transaction: ControlPlaneQuery,
  context: AuditContext,
  input: Omit<RecordAuditEventInput, "outcome" | "correlationId">,
): Promise<void> {
  await recordAuditEvent(transaction, {
    ...input, outcome: "succeeded", correlationId: context.correlationId,
  });
}

export async function createProjectApiKey(
  database: ControlPlaneDatabase,
  scope: ProjectScope,
  input: CreateProjectApiKeyInput,
  auditContext: AuditContext,
): Promise<CreatedProjectApiKey> {
  const scopes = normalizeScopes(input.scopes);
  if (
    input.expiresAt !== null &&
    (!(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= Date.now())
  ) {
    throw new Error("API key expiration must be a valid future date.");
  }

  const id = randomUUID();
  const publicId = randomBytes(4).toString("hex");
  const displayPrefix = `dya_live_${publicId}`;
  const rawKey = `${displayPrefix}_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashApiKey(rawKey);

  const apiKey = await database.transaction(async (transaction) => {
    await authorizeOrganizationWrite(transaction, scope, ["owner", "admin"]);
    const result = await transaction.query<ProjectApiKeyDatabaseRow>(`
      INSERT INTO api_keys(
        id, project_id, display_prefix, key_hash, created_by_user_id,
        tasks_write, results_read, project_admin, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      id,
      scope.projectId,
      displayPrefix,
      keyHash,
      scope.userId,
      scopes.includes("tasks:write"),
      scopes.includes("results:read"),
      scopes.includes("project:admin"),
      input.expiresAt,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("The API key insert returned no record.");
    }
    await recordCredentialAudit(transaction, auditContext, {
      organizationId: scope.organizationId, projectId: scope.projectId,
      actorType: "user", actorId: scope.userId, action: "api_key.created",
      targetType: "api_key", targetId: row.id,
    });
    return projectApiKeyMetadataFromRow(row);
  });

  return { apiKey, rawKey };
}

export async function authenticateProjectApiKey(
  database: ControlPlaneDatabase,
  rawKey: string,
  auditContext: AuditContext,
): Promise<AuthenticatedProjectApiKey> {
  requireApiKeyFormat(rawKey);
  return database.transaction(async (transaction) => {
    const result = await transaction.query<AuthenticatedApiKeyRow>(`
      UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP
      FROM projects
      WHERE api_keys.project_id = projects.id AND api_keys.key_hash = $1
        AND api_keys.revoked_at IS NULL
        AND (api_keys.expires_at IS NULL OR api_keys.expires_at > CURRENT_TIMESTAMP)
      RETURNING api_keys.id, api_keys.project_id, projects.organization_id,
        api_keys.created_by_user_id, api_keys.tasks_write,
        api_keys.results_read, api_keys.project_admin
    `, [hashApiKey(rawKey)]);
    const row = result.rows[0];
    if (row === undefined) throw new ProjectApiKeyAuthenticationError();
    await recordCredentialAudit(transaction, auditContext, {
      organizationId: row.organization_id, projectId: row.project_id,
      actorType: "api_key", actorId: row.id, action: "api_key.used",
      targetType: "api_key", targetId: row.id,
    });
    return Object.freeze({
      apiKeyId: row.id, projectId: row.project_id, organizationId: row.organization_id,
      createdByUserId: row.created_by_user_id,
      scopes: Object.freeze(scopesFromRow(row)),
    });
  });
}

export function requireProjectApiKeyScope(
  identity: AuthenticatedProjectApiKey,
  requiredScope: ProjectApiKeyScope,
): void {
  if (!identity.scopes.includes(requiredScope)) {
    throw new ProjectApiKeyScopeError();
  }
}

export async function revokeProjectApiKey(
  database: ControlPlaneDatabase,
  scope: ProjectScope,
  apiKeyId: string,
  auditContext: AuditContext,
): Promise<ProjectApiKeyMetadata> {
  if (apiKeyId.trim().length === 0) {
    throw new Error("apiKeyId must be a non-empty string.");
  }
  return database.transaction(async (transaction) => {
    await authorizeOrganizationWrite(transaction, scope, ["owner", "admin"]);
    const result = await transaction.query<ProjectApiKeyDatabaseRow>(`
      UPDATE api_keys
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL
      RETURNING *
    `, [apiKeyId, scope.projectId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ProjectApiKeyNotFoundError();
    }
    await recordCredentialAudit(transaction, auditContext, {
      organizationId: scope.organizationId, projectId: scope.projectId,
      actorType: "user", actorId: scope.userId, action: "api_key.revoked",
      targetType: "api_key", targetId: row.id,
    });
    return projectApiKeyMetadataFromRow(row);
  });
}

const workerEnrollmentTtlMs = 10 * 60 * 1_000;
const workerSessionTtlSeconds = 5 * 60;
const maximumCapabilityManifestBytes = 16 * 1_024;

export type WorkerCapabilityManifest = Readonly<Record<string, unknown>>;
export type WorkerIdentityConfig = Readonly<{
  sessionTokenIssuer: string;
  sessionTokenAudience: string;
  sessionTokenPrivateKey: KeyInput;
  sessionTokenPublicKey: KeyInput;
}>;
export type WorkerRecord = Readonly<{
  id: string;
  projectId: string;
  name: string;
  kind: "public" | "private";
  version: string;
  capabilityHash: string;
  status: "active" | "disabled";
  createdByUserId: string;
  createdAt: Date;
  disabledAt: Date | null;
}>;
export type CreatedWorkerEnrollment = Readonly<{
  enrollment: Readonly<{
    id: string;
    projectId: string;
    workerName: string;
    createdByUserId: string;
    expiresAt: Date;
  }>;
  rawToken: string;
}>;
export type WorkerChallenge = Readonly<{
  workerId: string;
  challenge: string;
  signingPayload: string;
  expiresAt: Date;
}>;
export type WorkerSession = Readonly<{ token: string; expiresAt: Date }>;
export type AuthenticatedWorker = Readonly<{
  workerId: string;
  projectId: string;
  capabilityHash: string;
  sessionId: string;
}>;

export class WorkerEnrollmentAuthenticationError extends Error {
  readonly code = "WORKER_ENROLLMENT_INVALID";
  constructor() {
    super("The Worker enrollment token is invalid, expired, or already used.");
    this.name = "WorkerEnrollmentAuthenticationError";
  }
}

export class WorkerPublicKeyError extends Error {
  readonly code = "WORKER_PUBLIC_KEY_INVALID";
  constructor() {
    super("The Worker public key must be a canonical Ed25519 SPKI key.");
    this.name = "WorkerPublicKeyError";
  }
}

export class WorkerAuthenticationError extends Error {
  readonly code = "WORKER_AUTHENTICATION_FAILED";
  constructor(cause?: unknown) {
    super(
      "The Worker identity, challenge, signature, or session is invalid.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "WorkerAuthenticationError";
  }
}

export class WorkerNotFoundError extends Error {
  readonly code = "WORKER_NOT_FOUND";
  constructor() {
    super("The Worker does not exist in this project or is already disabled.");
    this.name = "WorkerNotFoundError";
  }
}

type WorkerEnrollmentRow = {
  id: string;
  project_id: string;
  worker_name: string;
  created_by_user_id: string;
};
type ConsumedWorkerEnrollmentRow = WorkerEnrollmentRow & { organization_id: string };
type WorkerRow = {
  id: string;
  project_id: string;
  name: string;
  kind: "public" | "private";
  version: string;
  capability_hash: Buffer;
  status: "active" | "disabled";
  created_by_user_id: string;
  created_at: Date;
  disabled_at: Date | null;
};
type WorkerChallengeIdentityRow = {
  worker_id: string;
  project_id: string;
  public_key_id: string;
  public_key_spki: Buffer;
  capability_hash: Buffer;
};
type WorkerSessionInsertRow = {
  id: string;
  created_at: Date;
  expires_at: Date;
};

function requireWorkerText(value: string, name: string, maximumLength = 128): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(`${name} must contain between 1 and ${maximumLength} characters.`);
  }
  return normalized;
}

function requireWorkerIssuer(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("config.sessionTokenIssuer must be an absolute URL.", { cause: error });
  }
  if (url.protocol !== "https:") throw new Error("config.sessionTokenIssuer must use HTTPS.");
}

function hashWorkerValue(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function normalizeWorkerPublicKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 512) throw new WorkerPublicKeyError();
  const encoded = Buffer.from(value, "base64url");
  if (encoded.toString("base64url") !== value) throw new WorkerPublicKeyError();
  try {
    const key = createPublicKey({ key: encoded, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new WorkerPublicKeyError();
    return key.export({ format: "der", type: "spki" });
  } catch (error) {
    if (error instanceof WorkerPublicKeyError) throw error;
    throw new WorkerPublicKeyError();
  }
}

function workerCapabilityMaterial(manifest: WorkerCapabilityManifest): { json: string; hash: Buffer } {
  if (manifest === null || Array.isArray(manifest) || typeof manifest !== "object") {
    throw new Error("capabilities must be a JSON object.");
  }
  let json: string;
  try {
    json = JSON.stringify(manifest);
  } catch (error) {
    throw new Error("capabilities must be valid JSON.", { cause: error });
  }
  if (json === undefined || Buffer.byteLength(json) > maximumCapabilityManifestBytes) {
    throw new Error("capabilities must be a JSON object no larger than 16 KiB.");
  }
  return { json, hash: hashWorkerValue(json) };
}

function workerRecord(row: WorkerRow): WorkerRecord {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    version: row.version,
    capabilityHash: row.capability_hash.toString("base64url"),
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  });
}

function decodeWorkerSignature(signature: string): Buffer {
  if (!/^[A-Za-z0-9_-]{86}$/u.test(signature)) throw new WorkerAuthenticationError();
  const decoded = Buffer.from(signature, "base64url");
  if (decoded.byteLength !== 64 || decoded.toString("base64url") !== signature) {
    throw new WorkerAuthenticationError();
  }
  return decoded;
}

function workerClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export class WorkerIdentityService {
  private readonly now: () => Date;

  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly config: WorkerIdentityConfig,
    dependencies: Readonly<{ now?: () => Date }> = {},
  ) {
    requireWorkerIssuer(config.sessionTokenIssuer);
    requireWorkerText(config.sessionTokenAudience, "config.sessionTokenAudience", 512);
    this.now = dependencies.now ?? (() => new Date());
  }

  async createEnrollment(
    scope: ProjectScope,
    input: Readonly<{ workerName: string }>,
    auditContext: AuditContext,
  ): Promise<CreatedWorkerEnrollment> {
    const workerName = requireWorkerText(input.workerName, "input.workerName");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + workerEnrollmentTtlMs);
    const rawToken = `dya_we_${randomBytes(32).toString("base64url")}`;
    const enrollment = await this.database.transaction(async (transaction) => {
      await authorizeOrganizationWrite(transaction, scope, ["owner", "admin"]);
      const result = await transaction.query<WorkerEnrollmentRow>(`
        INSERT INTO worker_enrollments(
          id, project_id, worker_name, token_hash, created_by_user_id, created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, project_id, worker_name, created_by_user_id
      `, [
        randomUUID(), scope.projectId, workerName, hashWorkerValue(rawToken),
        scope.userId, now, expiresAt,
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("The Worker enrollment insert returned no record.");
      await recordCredentialAudit(transaction, auditContext, {
        organizationId: scope.organizationId, projectId: scope.projectId,
        actorType: "user", actorId: scope.userId, action: "worker.enrollment_created",
        targetType: "worker_enrollment", targetId: row.id,
      });
      return Object.freeze({
        id: row.id,
        projectId: row.project_id,
        workerName: row.worker_name,
        createdByUserId: row.created_by_user_id,
        expiresAt,
      });
    });
    return Object.freeze({ enrollment, rawToken });
  }

  async enroll(
    rawToken: string,
    input: Readonly<{
      publicKeySpki: string;
      version: string;
      capabilities: WorkerCapabilityManifest;
    }>,
    auditContext: AuditContext,
  ): Promise<WorkerRecord> {
    if (!/^dya_we_[A-Za-z0-9_-]{43}$/u.test(rawToken)) {
      throw new WorkerEnrollmentAuthenticationError();
    }
    const publicKey = normalizeWorkerPublicKey(input.publicKeySpki);
    const version = requireWorkerText(input.version, "input.version");
    const capabilities = workerCapabilityMaterial(input.capabilities);
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      const consumed = await transaction.query<ConsumedWorkerEnrollmentRow>(`
        UPDATE worker_enrollments AS enrollment SET consumed_at = $2
        FROM projects
        WHERE enrollment.token_hash = $1 AND enrollment.consumed_at IS NULL
          AND enrollment.expires_at > $2 AND projects.id = enrollment.project_id
        RETURNING enrollment.id, enrollment.project_id, enrollment.worker_name,
          enrollment.created_by_user_id, projects.organization_id
      `, [hashWorkerValue(rawToken), now]);
      const enrollment = consumed.rows[0];
      if (enrollment === undefined) throw new WorkerEnrollmentAuthenticationError();

      const workerId = randomUUID();
      const insertedWorker = await transaction.query<WorkerRow>(`
        INSERT INTO workers(
          id, project_id, name, version, capability_manifest, capability_hash,
          created_by_user_id, created_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
        RETURNING id, project_id, name, kind, version, capability_hash, status,
          created_by_user_id, created_at, disabled_at
      `, [
        workerId, enrollment.project_id, enrollment.worker_name, version,
        capabilities.json, capabilities.hash, enrollment.created_by_user_id, now,
      ]);
      const worker = insertedWorker.rows[0];
      if (worker === undefined) throw new Error("The Worker insert returned no record.");
      const insertedKey = await transaction.query<{ id: string }>(`
        INSERT INTO worker_public_keys(
          id, project_id, worker_id, algorithm, public_key_spki, fingerprint, created_at
        ) VALUES ($1, $2, $3, 'Ed25519', $4, $5, $6)
        RETURNING id
      `, [
        randomUUID(), enrollment.project_id, worker.id, publicKey,
        hashWorkerValue(publicKey), now,
      ]);
      if (insertedKey.rows[0] === undefined) {
        throw new Error("The Worker public key insert returned no record.");
      }
      await recordCredentialAudit(transaction, auditContext, {
        organizationId: enrollment.organization_id, projectId: enrollment.project_id,
        actorType: "user", actorId: enrollment.created_by_user_id, action: "worker.enrolled",
        targetType: "worker", targetId: worker.id,
      });
      return workerRecord(worker);
    });
  }

  async createChallenge(workerId: string): Promise<WorkerChallenge> {
    const normalizedWorkerId = requireWorkerText(workerId, "workerId");
    return createBoundedWorkerChallenge(
      this.database,
      normalizedWorkerId,
      () => new WorkerAuthenticationError(),
    );
  }

  async createSession(input: Readonly<{
    workerId: string;
    challenge: string;
    signature: string;
  }>): Promise<WorkerSession> {
    const workerId = requireWorkerText(input.workerId, "input.workerId");
    if (!/^dya_wc_[A-Za-z0-9_-]{43}$/u.test(input.challenge)) {
      throw new WorkerAuthenticationError();
    }
    const signature = decodeWorkerSignature(input.signature);
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<WorkerChallengeIdentityRow>(`
      SELECT challenges.worker_id, challenges.project_id, challenges.public_key_id,
        worker_public_keys.public_key_spki, workers.capability_hash
      FROM worker_session_challenges AS challenges
      INNER JOIN workers ON workers.id = challenges.worker_id
        AND workers.project_id = challenges.project_id
      INNER JOIN worker_public_keys ON worker_public_keys.id = challenges.public_key_id
        AND worker_public_keys.worker_id = challenges.worker_id
        AND worker_public_keys.project_id = challenges.project_id
      WHERE challenges.challenge_hash = $1 AND challenges.worker_id = $2
        AND challenges.consumed_at IS NULL AND challenges.expires_at > clock_timestamp()
        AND workers.status = 'active'
        AND worker_public_keys.revoked_at IS NULL
      FOR UPDATE OF challenges
    `, [hashWorkerValue(input.challenge), workerId]);
      const identity = selected.rows[0];
      if (identity === undefined) throw new WorkerAuthenticationError();
      try {
        const key = createPublicKey({ key: identity.public_key_spki, format: "der", type: "spki" });
        if (!verifySignature(
          null, Buffer.from(workerSigningPayload(input.challenge)), key, signature,
        )) throw new WorkerAuthenticationError();
      } catch (error) {
        if (error instanceof WorkerAuthenticationError) throw error;
        throw new WorkerAuthenticationError(error);
      }
      const sessionId = randomUUID();
      const inserted = await transaction.query<WorkerSessionInsertRow>(`
      WITH timing AS MATERIALIZED (
        SELECT clock_timestamp() AS created_at
      ), consumed AS (
        UPDATE worker_session_challenges SET consumed_at = timing.created_at
        FROM timing
        WHERE challenge_hash = $6 AND worker_id = $2
          AND project_id = $3 AND public_key_id = $4
          AND consumed_at IS NULL AND expires_at > timing.created_at
        RETURNING project_id, worker_id, public_key_id
      )
      INSERT INTO worker_sessions(
        id, project_id, worker_id, public_key_id, capability_hash, created_at, expires_at
      )
      SELECT $1, consumed.project_id, consumed.worker_id, consumed.public_key_id,
        workers.capability_hash, timing.created_at,
        timing.created_at + make_interval(secs => $7::integer)
      FROM consumed
      CROSS JOIN timing
      INNER JOIN workers ON workers.id = consumed.worker_id
        AND workers.project_id = consumed.project_id
      INNER JOIN worker_public_keys ON worker_public_keys.id = consumed.public_key_id
        AND worker_public_keys.worker_id = consumed.worker_id
        AND worker_public_keys.project_id = consumed.project_id
      WHERE workers.status = 'active' AND worker_public_keys.revoked_at IS NULL
        AND workers.capability_hash = $5
      RETURNING id, created_at, expires_at
    `, [
      sessionId, identity.worker_id, identity.project_id, identity.public_key_id,
      identity.capability_hash, hashWorkerValue(input.challenge), workerSessionTtlSeconds,
    ]);
      const session = inserted.rows[0];
      if (session === undefined) throw new WorkerAuthenticationError();
      const issuedAt = Math.floor(session.created_at.getTime() / 1_000);
      const expiresAt = session.expires_at;
      const capabilityHash = identity.capability_hash.toString("base64url");
      const token = await new SignJWT({
        project_id: identity.project_id, capability_hash: capabilityHash,
      })
        .setProtectedHeader({ alg: "EdDSA", typ: "worker+jwt" })
        .setIssuer(this.config.sessionTokenIssuer)
        .setAudience(this.config.sessionTokenAudience)
        .setSubject(identity.worker_id)
        .setJti(sessionId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
        .sign(this.config.sessionTokenPrivateKey);
      return Object.freeze({ token, expiresAt });
    });
  }

  async verifySession(token: string): Promise<AuthenticatedWorker> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.config.sessionTokenPublicKey, {
        algorithms: ["EdDSA"],
        issuer: this.config.sessionTokenIssuer,
        audience: this.config.sessionTokenAudience,
        typ: "worker+jwt",
        clockTolerance: 30,
        currentDate: this.now(),
        maxTokenAge: workerSessionTtlSeconds,
        requiredClaims: ["sub", "jti", "iat", "exp", "project_id", "capability_hash"],
      }));
    } catch (error) {
      throw new WorkerAuthenticationError(error);
    }
    const workerId = workerClaim(payload.sub);
    const sessionId = workerClaim(payload.jti);
    const projectId = workerClaim(payload.project_id);
    const capabilityHash = workerClaim(payload.capability_hash);
    if (
      workerId === null || sessionId === null || projectId === null || capabilityHash === null ||
      !/^[A-Za-z0-9_-]{43}$/u.test(capabilityHash)
    ) throw new WorkerAuthenticationError();

    const active = await this.database.query<{ active: boolean }>(`
      SELECT EXISTS(
        SELECT 1 FROM worker_sessions
        INNER JOIN workers ON workers.id = worker_sessions.worker_id
          AND workers.project_id = worker_sessions.project_id
        INNER JOIN worker_public_keys ON worker_public_keys.id = worker_sessions.public_key_id
          AND worker_public_keys.worker_id = worker_sessions.worker_id
          AND worker_public_keys.project_id = worker_sessions.project_id
        WHERE worker_sessions.id = $1 AND worker_sessions.worker_id = $2
          AND worker_sessions.project_id = $3 AND worker_sessions.capability_hash = $4
          AND workers.capability_hash = $4 AND worker_sessions.revoked_at IS NULL
          AND worker_sessions.expires_at > CURRENT_TIMESTAMP AND workers.status = 'active'
          AND worker_public_keys.revoked_at IS NULL
      ) AS active
    `, [sessionId, workerId, projectId, Buffer.from(capabilityHash, "base64url")]);
    if (active.rows[0]?.active !== true) throw new WorkerAuthenticationError();
    return Object.freeze({ workerId, projectId, capabilityHash, sessionId });
  }

  async disableWorker(
    scope: ProjectScope,
    workerId: string,
    auditContext: AuditContext,
  ): Promise<WorkerRecord> {
    const normalizedWorkerId = requireWorkerText(workerId, "workerId");
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await authorizeOrganizationWrite(transaction, scope, ["owner", "admin"]);
      const result = await transaction.query<WorkerRow>(`
        UPDATE workers SET status = 'disabled', disabled_at = $3
        WHERE id = $1 AND project_id = $2 AND status = 'active'
        RETURNING id, project_id, name, kind, version, capability_hash, status,
          created_by_user_id, created_at, disabled_at
      `, [normalizedWorkerId, scope.projectId, now]);
      const worker = result.rows[0];
      if (worker === undefined) throw new WorkerNotFoundError();
      await revokeWorkerCredentials(transaction, worker.id, worker.project_id, now);
      await recordCredentialAudit(transaction, auditContext, {
        organizationId: scope.organizationId, projectId: scope.projectId,
        actorType: "user", actorId: scope.userId, action: "worker.disabled",
        targetType: "worker", targetId: worker.id,
      });
      return workerRecord(worker);
    });
  }
}

async function revokeWorkerCredentials(
  transaction: ControlPlaneQuery,
  workerId: string,
  projectId: string,
  now: Date,
): Promise<void> {
  await transaction.query<{ id: string }>(`
    UPDATE worker_public_keys SET revoked_at = COALESCE(revoked_at, $3)
    WHERE worker_id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id
  `, [workerId, projectId, now]);
  await transaction.query<{ id: string }>(`
    UPDATE worker_sessions SET revoked_at = COALESCE(revoked_at, $3)
    WHERE worker_id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id
  `, [workerId, projectId, now]);
}
