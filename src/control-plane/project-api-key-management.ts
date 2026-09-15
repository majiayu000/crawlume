import {
  projectApiKeyMetadataFromRow,
  type ProjectApiKeyDatabaseRow,
  type ProjectApiKeyMetadata,
} from "./api-key-service.js";
import { authorizeOrganizationWrite } from "./organization-authorization.js";
import type { ControlPlaneDatabase, ProjectScope } from "./project-scope.js";

export type ProjectApiKeyCursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

export async function listProjectApiKeys(
  database: ControlPlaneDatabase,
  scope: ProjectScope,
  input: Readonly<{ limit: number; before: ProjectApiKeyCursor | null }>,
): Promise<readonly ProjectApiKeyMetadata[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101) {
    throw new Error("input.limit must be an integer from 1 to 101.");
  }
  if (
    input.before !== null &&
    (!(input.before.createdAt instanceof Date) ||
      !Number.isFinite(input.before.createdAt.getTime()) ||
      input.before.id.trim().length === 0)
  ) {
    throw new Error("input.before must contain a valid creation time and API Key ID.");
  }

  return database.transaction(async (transaction) => {
    await authorizeOrganizationWrite(transaction, scope, ["owner", "admin"]);
    const result = await transaction.query<ProjectApiKeyDatabaseRow>(`
      SELECT *
      FROM api_keys
      WHERE project_id = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $4
    `, [scope.projectId, input.before?.createdAt ?? null, input.before?.id ?? null, input.limit]);
    return Object.freeze(result.rows.map(projectApiKeyMetadataFromRow));
  });
}
