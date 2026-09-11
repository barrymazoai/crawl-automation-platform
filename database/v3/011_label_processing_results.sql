-- Admit the explicitly versioned grouped-label vision receipt. Existing facts remain immutable.
BEGIN;
SET LOCAL search_path=public;
DO $$
DECLARE constraint_name text; matches integer;
BEGIN
  SELECT count(*), min(conname::text) INTO matches, constraint_name FROM pg_constraint
    WHERE conrelid='public.processing_result'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%schemaVersion%';
  IF matches <> 1 THEN RAISE EXCEPTION 'Unexpected processing result version constraint'; END IF;
  EXECUTE format('ALTER TABLE public.processing_result DROP CONSTRAINT %I', constraint_name);
END;
$$;
ALTER TABLE processing_result ADD CONSTRAINT processing_result_codec CHECK(COALESCE(
  record->>'schemaVersion'='1' OR
  (record->>'schemaVersion'='2' AND record->>'codec'='vision-result/2'
    AND record->'input'->>'extractionProtocol'='label-extraction/1'), false));
COMMENT ON TABLE processing_result IS 'Immutable verified processing facts: existing /1 receipts and grouped-label vision-result/2. Application verifies complete evidence and exact codec; not a queue or product ingestion.';
COMMIT;
