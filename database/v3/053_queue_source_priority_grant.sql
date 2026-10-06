-- 052 created queue_source_priority without the runtime grant, so queue dispatch failed with "permission denied"
-- until the same grant was applied by hand on 2026-10-06 (CRAWLV3-210). This records it for every database.
BEGIN;
SET LOCAL search_path=public;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON queue_source_priority TO v3_runtime;
  END IF;
END $$;
COMMIT;
