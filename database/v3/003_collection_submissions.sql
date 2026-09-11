-- V3 business intake only. No activity scheduling, leases or retry engine.
BEGIN;
SET LOCAL search_path = public;

CREATE TABLE collection_submission (
  request_id uuid PRIMARY KEY REFERENCES api_request_receipt(request_id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES brand_source(id) ON DELETE RESTRICT,
  workflow_id text NOT NULL UNIQUE,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_id, source_id),
  CONSTRAINT collection_workflow_identity CHECK (workflow_id = 'v3-collection-' || request_id::text),
  CONSTRAINT collection_snapshot_identity CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot ?& ARRAY['brandId','brandName','sourceId','sourceRevision','channel','region','url']
    AND snapshot->>'sourceId' = source_id::text
  )
);

CREATE TABLE source_submission_guard (
  source_id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  FOREIGN KEY(request_id, source_id) REFERENCES collection_submission(request_id, source_id) ON DELETE RESTRICT
);

CREATE FUNCTION preserve_collection_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Collection submission is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER collection_submission_immutable BEFORE UPDATE OR DELETE ON collection_submission
  FOR EACH ROW EXECUTE FUNCTION preserve_collection_submission();

COMMENT ON TABLE collection_submission IS 'Immutable input snapshot + stable Workflow identity. Created atomically with API receipt and source guard. This slice has no dispatcher.';
COMMENT ON TABLE source_submission_guard IS 'One accepted request per source. No TTL and no public release API. A later coordinator must verify Temporal terminal evidence before release; disabled config or network timeout must never release it.';
COMMIT;
