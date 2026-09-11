-- Passive, immutable error evidence; no queue state, retry counter or consumer.
BEGIN;
SET LOCAL search_path=public;
CREATE TABLE review_record (
  review_id text COLLATE "C" PRIMARY KEY CHECK(review_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'),
  record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(COALESCE(record->>'schemaVersion'='1',false)),
  CHECK(COALESCE(record->>'reviewId'=review_id,false)),
  CHECK(COALESCE(jsonb_typeof(record->'rawError')='object',false)),
  CHECK(COALESCE(jsonb_typeof(record->'candidate') IN ('object','null'),false)),
  CHECK(COALESCE(record->'failure'->>'automaticRetry'='false',false)),
  CHECK(COALESCE(record->'failure'->>'executionFact' IN ('not_executed','executed','unknown'),false)),
  CHECK(COALESCE(record->'failure'->>'category' IN ('SOURCE','RUNTIME','ARTIFACT','PROCESSING','VALIDATION','IDENTITY','INGEST','SCHEDULER','UNCLASSIFIED'),false)),
  CHECK(COALESCE(record->'failure'->>'code' ~ '^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$',false)),
  CHECK(COALESCE(jsonb_typeof(record->'failure'->'blockedBy')='null' OR
    (jsonb_typeof(record->'failure'->'blockedBy')='string' AND record->'failure'->>'executionFact'='not_executed'
     AND record->'failure'->>'blockedBy' <> record->'failure'->>'operationId'),false))
);
CREATE INDEX review_record_request ON review_record ((record->'failure'->>'requestId'),review_id DESC);
CREATE INDEX review_record_operation ON review_record ((record->'failure'->>'operationId'),review_id DESC);
CREATE INDEX review_record_category ON review_record ((record->'failure'->>'category'),review_id DESC);
CREATE FUNCTION preserve_review_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Review records cannot be modified or deleted' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER review_record_immutable BEFORE UPDATE OR DELETE ON review_record
  FOR EACH ROW EXECUTE FUNCTION preserve_review_record();
COMMENT ON TABLE review_record IS 'Private full candidate and original error evidence. Append-only passive journal, not a task queue. HTTP must use an allowlisted projection, never expose raw record.';
COMMIT;
