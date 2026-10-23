import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { AuthenticatedProjectApiKey, AuthenticatedWorker } from "./api-key-service.js";
import {
  JobResultValidationError,
  lockResultSubmissionLease,
  recordAuditEvent,
  requireActiveResultWorkerSession,
  type AuditContext,
} from "./organization-authorization.js";
import type { ControlPlaneDatabase, ControlPlaneQuery } from "./project-scope.js";

export type PresignedUpload = Readonly<{
  url: string;
  method: "PUT";
  headers: Readonly<Record<string, string>>;
  expiresAt: Date;
}>;

export type StoredObject = Readonly<{ byteCount: number; sha256Base64: string | null }>;

export interface ArtifactObjectStore {
  presignPut(key: string, input: Readonly<{
    byteCount: number;
    sha256Base64: string;
    mediaType: string;
    expiresInSeconds: number;
  }>): Promise<Readonly<{ url: string; headers: Readonly<Record<string, string>> }>>;
  head(key: string): Promise<StoredObject | null>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
}

export class ArtifactStorageDisabledError extends Error {
  readonly code = "ARTIFACT_STORAGE_DISABLED";
  constructor() {
    super("Cloud Artifact storage is not configured.");
    this.name = "ArtifactStorageDisabledError";
  }
}

export class ArtifactNotFoundError extends Error {
  readonly code = "ARTIFACT_NOT_FOUND";
  constructor() {
    super("The cloud Artifact does not exist in this Project or has not been uploaded.");
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactUploadVerificationError extends Error {
  readonly code = "ARTIFACT_UPLOAD_UNVERIFIED";
  constructor(message: string) {
    super(message);
    this.name = "ArtifactUploadVerificationError";
  }
}

/** S3-compatible store (AWS S3, MinIO, Cloudflare R2). Credentials come from the AWS default chain. */
export class S3ArtifactObjectStore implements ArtifactObjectStore {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  async presignPut(key: string, input: Parameters<ArtifactObjectStore["presignPut"]>[1]) {
    const headers = {
      "content-type": input.mediaType,
      "x-amz-checksum-sha256": input.sha256Base64,
    };
    const url = await getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentLength: input.byteCount,
      ContentType: input.mediaType,
      ChecksumSHA256: input.sha256Base64,
    }), {
      expiresIn: input.expiresInSeconds,
      signableHeaders: new Set(["content-length", "content-type", "x-amz-checksum-sha256"]),
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
    });
    return { url, headers };
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED",
      }));
      return { byteCount: head.ContentLength ?? -1, sha256Base64: head.ChecksumSHA256 ?? null };
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}

export function artifactObjectStoreFromEnvironment(environment: NodeJS.ProcessEnv): ArtifactObjectStore | null {
  const bucket = environment.DIAOYAN_ARTIFACT_S3_BUCKET;
  if (bucket === undefined || bucket === "") return null;
  const forcePathStyle = environment.DIAOYAN_ARTIFACT_S3_FORCE_PATH_STYLE;
  if (forcePathStyle !== undefined && forcePathStyle !== "0" && forcePathStyle !== "1") {
    throw new Error("DIAOYAN_ARTIFACT_S3_FORCE_PATH_STYLE must be 0 or 1.");
  }
  const endpoint = environment.DIAOYAN_ARTIFACT_S3_ENDPOINT;
  return new S3ArtifactObjectStore(new S3Client({
    region: environment.DIAOYAN_ARTIFACT_S3_REGION ?? "us-east-1",
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
    forcePathStyle: forcePathStyle === "1",
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }), bucket);
}

type LeaseCloudArtifact = Readonly<{
  objectKey: string;
  contentHash: string;
  byteCount: number;
  mediaType: string;
  uploadedAt: Date | null;
}>;

type LeaseCloudArtifactRow = {
  object_key: string | null;
  content_hash: Buffer;
  byte_count: number | string;
  media_type: string;
  uploaded_at: Date | null;
};

/**
 * Runs operation while holding the active lease that published a cloud Artifact, so upload
 * brokering is fenced exactly like publication. Unknown or worker-local Artifacts are rejected.
 */
async function withLeaseCloudArtifact<Result>(
  database: ControlPlaneDatabase,
  identity: AuthenticatedWorker,
  leaseId: string,
  leaseGeneration: number,
  artifactId: string,
  operation: (artifact: LeaseCloudArtifact, transaction: ControlPlaneQuery) => Promise<Result>,
): Promise<Result> {
  return database.transaction(async (transaction) => {
    await requireActiveResultWorkerSession(transaction, identity);
    await lockResultSubmissionLease(transaction, identity, leaseId, leaseGeneration);
    const result = await transaction.query<LeaseCloudArtifactRow>(`
      SELECT artifact_metadata.object_key, artifact_metadata.content_hash,
        artifact_metadata.byte_count, artifact_metadata.media_type, artifact_metadata.uploaded_at
      FROM artifact_metadata
      INNER JOIN job_publications ON job_publications.artifact_id = artifact_metadata.id
        AND job_publications.project_id = artifact_metadata.project_id
      WHERE artifact_metadata.id = $1 AND artifact_metadata.project_id = $2
        AND job_publications.lease_id = $3 AND artifact_metadata.storage_kind = 'cloud_object'
      FOR UPDATE OF artifact_metadata
    `, [artifactId, identity.projectId, leaseId]);
    const row = result.rows[0];
    if (row === undefined || row.object_key === null) {
      throw new JobResultValidationError("artifact_id must name a cloud Artifact published by this lease.");
    }
    return operation(Object.freeze({
      objectKey: row.object_key,
      contentHash: row.content_hash.toString("base64url"),
      byteCount: Number(row.byte_count),
      mediaType: row.media_type,
      uploadedAt: row.uploaded_at,
    }), transaction);
  });
}

const uploadUrlTtlSeconds = 15 * 60;
const downloadUrlTtlSeconds = 5 * 60;

function sha256Base64(contentHash: string): string {
  return Buffer.from(contentHash, "base64url").toString("base64");
}

/**
 * Brokers cloud Artifact bytes: Workers upload with a presigned PUT bound to the published size and
 * SHA-256, then confirm; Project API keys download through short-lived presigned GET URLs.
 */
export class ArtifactStorageService {
  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly store: ArtifactObjectStore | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestUpload(
    identity: AuthenticatedWorker,
    leaseId: string,
    generation: number,
    artifactId: string,
  ): Promise<PresignedUpload> {
    const store = this.requireStore();
    return withLeaseCloudArtifact(this.database, identity, leaseId, generation, artifactId, async (artifact) => {
      const expiresAt = new Date(this.now().getTime() + uploadUrlTtlSeconds * 1_000);
      const presigned = await store.presignPut(artifact.objectKey, {
        byteCount: artifact.byteCount,
        sha256Base64: sha256Base64(artifact.contentHash),
        mediaType: artifact.mediaType,
        expiresInSeconds: uploadUrlTtlSeconds,
      });
      return Object.freeze({ url: presigned.url, method: "PUT" as const, headers: presigned.headers, expiresAt });
    });
  }

  async confirmUpload(
    identity: AuthenticatedWorker,
    leaseId: string,
    generation: number,
    artifactId: string,
  ): Promise<Date> {
    const store = this.requireStore();
    const snapshot = await withLeaseCloudArtifact(
      this.database, identity, leaseId, generation, artifactId,
      async (artifact) => artifact,
    );
    if (snapshot.uploadedAt !== null) return snapshot.uploadedAt;
    // Object storage can be slow; release database locks before the network request.
    const stored = await store.head(snapshot.objectKey);
    return withLeaseCloudArtifact(
      this.database, identity, leaseId, generation, artifactId,
      async (artifact, transaction) => {
        if (artifact.uploadedAt !== null) return artifact.uploadedAt;
        if (stored === null) throw new ArtifactUploadVerificationError("The Artifact object has not been uploaded.");
        if (stored.byteCount !== artifact.byteCount ||
            stored.sha256Base64 !== sha256Base64(artifact.contentHash)) {
          throw new ArtifactUploadVerificationError(
            "The uploaded object does not match the published size and SHA-256.",
          );
        }
        const updated = await transaction.query<{ uploaded_at: Date }>(`
          UPDATE artifact_metadata SET uploaded_at = clock_timestamp()
          WHERE id = $1 AND project_id = $2 AND uploaded_at IS NULL
          RETURNING uploaded_at
        `, [artifactId, identity.projectId]);
        const uploadedAt = updated.rows[0]?.uploaded_at;
        if (uploadedAt === undefined) throw new Error("The Artifact upload confirmation updated no row.");
        return uploadedAt;
      },
    );
  }

  async downloadUrl(
    identity: AuthenticatedProjectApiKey,
    artifactId: string,
    context: AuditContext,
  ): Promise<Readonly<{ url: string; expiresAt: Date }>> {
    const store = this.requireStore();
    return this.database.transaction(async (transaction) => {
      const found = await transaction.query<{ object_key: string }>(`
        SELECT object_key FROM artifact_metadata
        WHERE id = $1 AND project_id = $2 AND storage_kind = 'cloud_object' AND uploaded_at IS NOT NULL
      `, [artifactId, identity.projectId]);
      const objectKey = found.rows[0]?.object_key;
      if (objectKey === undefined) throw new ArtifactNotFoundError();
      await recordAuditEvent(transaction, {
        organizationId: identity.organizationId, projectId: identity.projectId,
        actorType: "api_key", actorId: identity.apiKeyId, action: "artifact.downloaded",
        targetType: "artifact", targetId: artifactId, outcome: "succeeded",
        correlationId: context.correlationId,
      });
      const expiresAt = new Date(this.now().getTime() + downloadUrlTtlSeconds * 1_000);
      return Object.freeze({ url: await store.presignGet(objectKey, downloadUrlTtlSeconds), expiresAt });
    });
  }

  private requireStore(): ArtifactObjectStore {
    if (this.store === null) throw new ArtifactStorageDisabledError();
    return this.store;
  }
}
