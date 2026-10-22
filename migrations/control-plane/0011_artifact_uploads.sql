BEGIN;

-- Cloud Artifact bytes are uploaded by the Worker after publication; the control plane records
-- uploaded_at only after verifying the stored object's size and SHA-256 checksum.
ALTER TABLE artifact_metadata
  ADD COLUMN uploaded_at TIMESTAMPTZ,
  ADD CONSTRAINT artifact_metadata_upload_requires_cloud_object CHECK (
    uploaded_at IS NULL OR storage_kind = 'cloud_object'
  );

COMMIT;
