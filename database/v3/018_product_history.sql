BEGIN;

-- Historical imports are not newly verified collected_product records.
CREATE TABLE product_history_source (
  source_record_id text PRIMARY KEY,
  dataset text NOT NULL,
  source_key text NOT NULL,
  body_hash text NOT NULL,
  record jsonb NOT NULL,
  issues jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(dataset, source_key, body_hash),
  CHECK (length(source_record_id)=64 AND length(body_hash)=64)
);
CREATE INDEX product_history_source_dataset ON product_history_source(dataset, source_key);
CREATE TABLE product_history_listing (
  listing_id text PRIMARY KEY,
  channel text NOT NULL,
  site text,
  external_id text,
  identity_basis text NOT NULL CHECK (identity_basis IN ('external-id','url','unresolved')),
  identity jsonb NOT NULL,
  CHECK (length(listing_id)=64)
);
CREATE TABLE product_history_listing_source (
  listing_id text NOT NULL REFERENCES product_history_listing,
  source_record_id text NOT NULL REFERENCES product_history_source,
  url text,
  PRIMARY KEY(listing_id,source_record_id)
);
CREATE INDEX product_history_listing_source_origin ON product_history_listing_source(source_record_id);
CREATE TABLE product_history_observation (
  observation_id text PRIMARY KEY,
  listing_id text NOT NULL REFERENCES product_history_listing,
  kind text NOT NULL CHECK (kind IN ('metrics','formula')),
  observed_at timestamptz,
  record jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(observation_id)=64)
);
CREATE INDEX product_history_observation_time ON product_history_observation(listing_id,kind,observed_at);
CREATE TABLE product_history_observation_source (
  observation_id text NOT NULL REFERENCES product_history_observation,
  source_record_id text NOT NULL REFERENCES product_history_source,
  PRIMARY KEY(observation_id,source_record_id)
);
CREATE FUNCTION product_history_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'History is append-only'; END;
$$;
CREATE TRIGGER product_history_source_immutable BEFORE UPDATE OR DELETE ON product_history_source FOR EACH ROW EXECUTE FUNCTION product_history_reject_change();
CREATE TRIGGER product_history_listing_immutable BEFORE UPDATE OR DELETE ON product_history_listing FOR EACH ROW EXECUTE FUNCTION product_history_reject_change();
CREATE TRIGGER product_history_listing_source_immutable BEFORE UPDATE OR DELETE ON product_history_listing_source FOR EACH ROW EXECUTE FUNCTION product_history_reject_change();
CREATE TRIGGER product_history_observation_immutable BEFORE UPDATE OR DELETE ON product_history_observation FOR EACH ROW EXECUTE FUNCTION product_history_reject_change();
CREATE TRIGGER product_history_observation_source_immutable BEFORE UPDATE OR DELETE ON product_history_observation_source FOR EACH ROW EXECUTE FUNCTION product_history_reject_change();
COMMIT;
