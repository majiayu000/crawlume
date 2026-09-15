import { describe, expect, it } from "vitest";

import { JobResultService } from "../src/control-plane/organization-authorization.js";
import type {
  ControlPlaneDatabase,
  ControlPlaneQuery,
} from "../src/control-plane/project-scope.js";

type Call = { statement: string; parameters: readonly unknown[] };
type Response = { rows: unknown[] };

class PublicationDatabase implements ControlPlaneDatabase {
  readonly calls: Call[] = [];
  constructor(private readonly responses: Response[]) {}

  transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.calls.push({ statement, parameters });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("Unexpected publication query.");
    return response as { rows: Row[] };
  }
}

const now = new Date("2026-09-02T08:00:00.000Z");

function publicationRow(sequence: number, id: string): Record<string, unknown> {
  return {
    id,
    project_id: "project-a",
    job_id: "job-a",
    lease_id: "lease-a",
    worker_id: "worker-a",
    lease_generation: "1",
    local_sequence: String(sequence),
    sequence: String(sequence),
    publication_hash: Buffer.alloc(32, sequence),
    result_completeness: "complete",
    recorded_at: now,
    artifact_id: `artifact-${id}`,
    artifact_version: 1,
    artifact_content_hash: Buffer.alloc(32, sequence),
    artifact_byte_count: "42",
    artifact_media_type: "text/markdown",
    artifact_storage_kind: "worker_local",
    artifact_object_key: null,
    artifact_created_at: now,
  };
}

describe("Project publication listing", () => {
  it("uses Project-bound sequence pagination and reports another page", async () => {
    const database = new PublicationDatabase([
      { rows: [{ id: "job-a" }] },
      { rows: [publicationRow(3, "publication-a"), publicationRow(4, "publication-b")] },
    ]);

    const page = await new JobResultService(database).listPublications(
      { projectId: "project-a" },
      "job-a",
      { afterSequence: 2, limit: 1 },
    );

    expect(page).toMatchObject({ hasMore: true, nextSequence: 3 });
    expect(page?.items).toHaveLength(1);
    expect(page?.items[0]).toMatchObject({ id: "publication-a", sequence: 3 });
    expect(database.calls[0]?.parameters).toEqual(["job-a", "project-a"]);
    expect(database.calls[1]?.parameters).toEqual(["project-a", "job-a", 2, 2]);
    expect(database.calls[1]?.statement).toContain(
      "job_publications.project_id = $1 AND job_publications.job_id = $2",
    );
    expect(database.calls[1]?.statement).toContain("job_publications.sequence > $3");
  });

  it("returns null for a Job outside the Project without querying publications", async () => {
    const database = new PublicationDatabase([{ rows: [] }]);

    await expect(new JobResultService(database).listPublications(
      { projectId: "project-a" },
      "job-b",
      { afterSequence: null, limit: 50 },
    )).resolves.toBeNull();
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.parameters).toEqual(["job-b", "project-a"]);
  });
});
