-- New-system collection snapshots only; not synchronization to a legacy/formal product service.
BEGIN;
SET LOCAL search_path=public;
CREATE TABLE collected_product (
  operation_id text PRIMARY KEY CHECK(operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'),
  observation_id text UNIQUE NOT NULL CHECK(observation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'),
  record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
  collected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(COALESCE(record->>'schemaVersion'='1' AND record->>'codec'='collected-product/1',false)),
  CHECK(COALESCE(record->>'operationId'=operation_id,false)),
  CHECK(COALESCE(record->'observation'->>'observationId'=observation_id,false)),
  CHECK(COALESCE(jsonb_typeof(record->'formula')='object',false)),
  CHECK(COALESCE(jsonb_typeof(record->'ingredients')='array' AND jsonb_array_length(record->'ingredients')>0,false)),
  CHECK(COALESCE(jsonb_typeof(record->'assembly')='object',false))
);
CREATE INDEX collected_product_brand ON collected_product ((record->'observation'->>'brandId'));
CREATE FUNCTION preserve_collected_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Collected snapshots cannot be modified or deleted' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER collected_product_immutable BEFORE UPDATE OR DELETE ON collected_product
  FOR EACH ROW EXECUTE FUNCTION preserve_collected_product();
COMMENT ON TABLE collected_product IS 'Immutable verified Formula/Ingredients collection snapshot. No company matching prerequisite; not a task queue or formal product service synchronization receipt.';
COMMIT;
