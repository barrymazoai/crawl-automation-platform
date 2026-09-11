-- Immutable result facts only. Never a task queue or a provider execution claim.
BEGIN;
SET LOCAL search_path=public;
CREATE TABLE processing_result (
  operation_id text PRIMARY KEY CHECK(operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'),
  record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(COALESCE(record->>'schemaVersion'='1',false)),
  CHECK(COALESCE(record->'input'->>'operationId'=operation_id,false)),
  CHECK(COALESCE(jsonb_typeof(record->'result')='object',false)),
  CHECK(COALESCE(jsonb_typeof(record->'completion')='object',false))
);
CREATE FUNCTION preserve_processing_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Processing results cannot be modified or deleted' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER processing_result_immutable BEFORE UPDATE OR DELETE ON processing_result
  FOR EACH ROW EXECUTE FUNCTION preserve_processing_result();
COMMENT ON TABLE processing_result IS 'Verified processing result registration; application must verify remote evidence before insert and after read. Not product ingestion, Workflow completion, or a provider invocation permit.';
COMMIT;
