import { createHash, randomUUID } from "node:crypto";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";

import { artifactObjectStoreFromEnvironment, type ArtifactObjectStore } from "../src/control-plane/artifact-storage.js";

const endpoint = process.env.DIAOYAN_TEST_S3_ENDPOINT ?? "";
const describeWithS3 = endpoint === "" ? describe.skip : describe;

describeWithS3("S3 Artifact object store", () => {
  const bucket = `crawlume-test-${randomUUID()}`;
  let store: ArtifactObjectStore;

  beforeAll(async () => {
    const environment = {
      ...process.env,
      DIAOYAN_ARTIFACT_S3_BUCKET: bucket,
      DIAOYAN_ARTIFACT_S3_ENDPOINT: endpoint,
      DIAOYAN_ARTIFACT_S3_FORCE_PATH_STYLE: "1",
    };
    await new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true })
      .send(new CreateBucketCommand({ Bucket: bucket }));
    const configured = artifactObjectStoreFromEnvironment(environment);
    if (configured === null) throw new Error("The S3 test store was not configured.");
    store = configured;
  });

  async function presignedPut(key: string, body: Buffer, declared: Buffer = body) {
    const presigned = await store.presignPut(key, {
      byteCount: declared.byteLength,
      sha256Base64: createHash("sha256").update(declared).digest("base64"),
      mediaType: "application/json",
      expiresInSeconds: 60,
    });
    return fetch(presigned.url, { method: "PUT", headers: presigned.headers, body: new Uint8Array(body) });
  }

  it("uploads through a presigned PUT, verifies by HEAD, and downloads through a presigned GET", async () => {
    const key = `organization/o/project/p/artifact/${randomUUID()}/1`;
    const body = Buffer.from(JSON.stringify({ result: "cloud artifact" }));
    await expect(store.head(key)).resolves.toBeNull();

    const uploaded = await presignedPut(key, body);
    expect(uploaded.status).toBe(200);
    await expect(store.head(key)).resolves.toEqual({
      byteCount: body.byteLength,
      sha256Base64: createHash("sha256").update(body).digest("base64"),
    });

    const downloaded = await fetch(await store.presignGet(key, 60));
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(body);
  });

  it("rejects an upload whose bytes do not match the signed SHA-256", async () => {
    const key = `organization/o/project/p/artifact/${randomUUID()}/1`;
    const declared = Buffer.from("published bytes!");
    const tampered = Buffer.from("tampered bytes!!");
    const response = await presignedPut(key, tampered, declared);
    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(store.head(key)).resolves.toBeNull();
  });
});
