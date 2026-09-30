-- The shared capture step records each paid HTML fetch in html_capture (033) and reuses a saved original for 24
-- hours; 033 did not grant the services' database role, so every product capture stopped at its first lookup
-- (2026-09-30, permission denied). The role may add and read attempts and finish an in-flight one; the table's
-- trigger still refuses every other change.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON html_capture TO v3_runtime;
  END IF;
END;
$$;
COMMIT;
