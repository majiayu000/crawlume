BEGIN;

-- Retention first tombstones an Artifact (no longer downloadable), then deletes its object.
-- Rows stay for publication history; object_deleted_at IS NULL marks deletions still to reconcile.
ALTER TABLE artifact_metadata
  ADD COLUMN tombstoned_at TIMESTAMPTZ,
  ADD COLUMN object_deleted_at TIMESTAMPTZ,
  ADD CONSTRAINT artifact_metadata_deletion_after_tombstone CHECK (
    object_deleted_at IS NULL OR tombstoned_at IS NOT NULL
  ),
  ADD CONSTRAINT artifact_metadata_tombstone_requires_cloud_object CHECK (
    tombstoned_at IS NULL OR storage_kind = 'cloud_object'
  );

CREATE INDEX artifact_metadata_retention_pending
  ON artifact_metadata(tombstoned_at, id)
  WHERE storage_kind = 'cloud_object' AND object_deleted_at IS NULL;

COMMIT;
