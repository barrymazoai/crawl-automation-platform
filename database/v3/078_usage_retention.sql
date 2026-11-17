BEGIN;
-- Owner 2026-11-17: `usage_event` grew ~0.75G a day on Server 一, nine tenths of it per-step timing rows
-- (`activity`) and reuse rows (`preparation`). The API's hourly cleanup removes those after seven days. Cost rows
-- (captures, model calls, OCR, brand requests) stay immutable: they can be neither changed nor removed. The
-- database itself refuses removing a timing or reuse row younger than seven days. No row is changed or removed by
-- this migration.
CREATE OR REPLACE FUNCTION preserve_usage_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.kind IN ('activity', 'preparation')
     AND OLD.started_at < now() - interval '7 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Usage events are immutable' USING ERRCODE='23514';
END;
$$;

-- The cleanup finds removable rows without walking past every cost row kept forever.
CREATE INDEX usage_event_retention ON usage_event(started_at)
  WHERE kind IN ('activity', 'preparation');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='v3_runtime') THEN
    GRANT DELETE ON usage_event TO v3_runtime;
  END IF;
END;
$$;
COMMIT;
