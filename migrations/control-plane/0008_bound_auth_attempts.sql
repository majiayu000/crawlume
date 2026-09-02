BEGIN;

LOCK TABLE worker_session_challenges IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM worker_session_challenges
    GROUP BY worker_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'worker_session_challenges contains duplicate worker_id rows; resolve them before migration';
  END IF;
END;
$$;

DROP INDEX worker_session_challenges_worker_open;

ALTER TABLE worker_session_challenges
  ADD CONSTRAINT worker_session_challenges_worker_unique UNIQUE (worker_id);

COMMIT;
