import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedProjectApiKey, AuthenticatedWorker } from "../src/control-plane/api-key-service.js";
import {
  ArtifactNotFoundError,
  ArtifactStorageDisabledError,
  ArtifactUploadVerificationError,
} from "../src/control-plane/artifact-storage.js";
import { WorkerHttpApi } from "../src/control-plane/organization-service.js";
import { ProjectJobHttpApi } from "../src/control-plane/project-http-api.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const requestId = "11111111-1111-4111-8111-111111111111";
const expiresAt = new Date("2026-10-22T00:15:00.000Z");
const worker: AuthenticatedWorker = Object.freeze({
  workerId: "55555555-5555-4555-8555-555555555555",
  projectId,
  sessionId: "66666666-6666-4666-8666-666666666666",
  capabilityHash: Buffer.alloc(32, 1).toString("base64url"),
});

function workerApi(artifacts?: ConstructorParameters<typeof WorkerHttpApi>[0]["artifacts"]) {
  const unused = vi.fn(async () => {
    throw new Error("unexpected service call");
  });
  return new WorkerHttpApi({
    identity: { verifySession: vi.fn(async () => worker) },
    jobs: { claimNext: unused, heartbeat: unused, complete: unused },
    results: { appendEvent: unused, publishResult: unused },
    ...(artifacts === undefined ? {} : { artifacts }),
  }, { requestId: () => requestId });
}

function workerRequest(suffix: string, body: unknown = { generation: 1, artifact_id: artifactId }) {
  return {
    method: "POST",
    path: `/v1/job-leases/${leaseId}/artifact-uploads${suffix}`,
    query: "",
    headers: { authorization: "Bearer a.b.c", "content-type": "application/json" },
    body,
  };
}

describe("Worker Artifact upload routes", () => {
  it("issues a presigned upload for the lease and Artifact", async () => {
    const requestUpload = vi.fn(async () => ({
      url: "https://objects.example/key?signature", method: "PUT" as const,
      headers: { "x-amz-checksum-sha256": "abc" }, expiresAt,
    }));
    const response = await workerApi({ requestUpload, confirmUpload: vi.fn() }).handle(workerRequest(""));
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      request_id: requestId,
      upload: {
        url: "https://objects.example/key?signature", method: "PUT",
        headers: { "x-amz-checksum-sha256": "abc" }, expires_at: expiresAt.toISOString(),
      },
    });
    expect(requestUpload).toHaveBeenCalledWith(worker, leaseId, 1, artifactId);
  });

  it("confirms an upload and reports an unverified object as a retryable conflict", async () => {
    const confirmUpload = vi.fn()
      .mockRejectedValueOnce(new ArtifactUploadVerificationError("The Artifact object has not been uploaded."))
      .mockResolvedValueOnce(expiresAt);
    const api = workerApi({ requestUpload: vi.fn(), confirmUpload });
    const unverified = await api.handle(workerRequest("/confirm"));
    expect(unverified.status).toBe(409);
    expect(unverified.body).toMatchObject({ code: "ARTIFACT_UPLOAD_UNVERIFIED", retryable: true });
    const confirmed = await api.handle(workerRequest("/confirm"));
    expect(confirmed).toMatchObject({ status: 200, body: { uploaded_at: expiresAt.toISOString() } });
  });

  it("answers 503 when storage is not configured and 422 for an invalid body", async () => {
    expect((await workerApi().handle(workerRequest(""))).status).toBe(503);
    const invalid = await workerApi({ requestUpload: vi.fn(), confirmUpload: vi.fn() })
      .handle(workerRequest("", { generation: 1, artifact_id: "not-a-uuid" }));
    expect(invalid.status).toBe(422);
  });
});

describe("Project Artifact download route", () => {
  function projectApi(
    downloadUrl: ReturnType<typeof vi.fn>,
    scopes: AuthenticatedProjectApiKey["scopes"] = ["results:read"],
  ) {
    const unused = vi.fn(async () => {
      throw new Error("unexpected service call");
    });
    return new ProjectJobHttpApi({
      authenticate: vi.fn(async () => Object.freeze({
        apiKeyId: "key-a", projectId, organizationId: "organization-a", createdByUserId: "user-a", scopes,
      })),
      createJob: unused, getJob: unused, pauseJob: unused, resumeJob: unused, cancelJob: unused,
      listPublications: unused, listAuditEvents: unused,
      artifacts: { downloadUrl },
    }, { requestId: () => requestId });
  }

  const download = {
    method: "GET",
    path: `/v1/projects/${projectId}/artifacts/${artifactId}/download`,
    query: "",
    headers: { authorization: `Bearer dya_live_deadbeef_${"A".repeat(43)}` },
    body: undefined,
  };

  it("returns a no-store presigned URL", async () => {
    const downloadUrl = vi.fn(async () => ({ url: "https://objects.example/key?get", expiresAt }));
    const response = await projectApi(downloadUrl).handle(download);
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ "cache-control": "no-store" });
    expect(response.body).toEqual({
      request_id: requestId, url: "https://objects.example/key?get", expires_at: expiresAt.toISOString(),
    });
    expect(downloadUrl).toHaveBeenCalledWith(expect.objectContaining({ apiKeyId: "key-a" }), artifactId, {
      correlationId: requestId,
    });
  });

  it.each([
    [new ArtifactNotFoundError(), 404, "ARTIFACT_NOT_FOUND"],
    [new ArtifactStorageDisabledError(), 503, "ARTIFACT_STORAGE_DISABLED"],
  ])("maps %s", async (error, status, code) => {
    const response = await projectApi(vi.fn(async () => { throw error; })).handle(download);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code });
  });

  it("requires results:read", async () => {
    const downloadUrl = vi.fn();
    expect((await projectApi(downloadUrl, ["tasks:write"]).handle(download)).status).toBe(403);
    expect(downloadUrl).not.toHaveBeenCalled();
  });
});
