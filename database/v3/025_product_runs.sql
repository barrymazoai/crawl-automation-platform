BEGIN;
-- A run of one product page on one channel (the shared product pipeline). The run ID is the caller's request ID,
-- so repeating a request returns the same run. Only the Temporal run ID is written after acceptance, once.
CREATE TABLE product_run (
  run_id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES brand_source(id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL REFERENCES brand(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  url text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 4096),
  workflow_id text NOT NULL UNIQUE CHECK (workflow_id = 'product-run-' || run_id::text),
  started_run_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX product_run_recent ON product_run(created_at DESC);
CREATE FUNCTION preserve_product_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.started_run_id IS NOT NULL OR NEW.started_run_id IS NULL OR
    ROW(OLD.run_id,OLD.source_id,OLD.brand_id,OLD.channel,OLD.url,OLD.workflow_id,OLD.created_at) IS DISTINCT FROM
    ROW(NEW.run_id,NEW.source_id,NEW.brand_id,NEW.channel,NEW.url,NEW.workflow_id,NEW.created_at) THEN
    RAISE EXCEPTION 'A product run is immutable once accepted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_run_immutable BEFORE UPDATE OR DELETE ON product_run
  FOR EACH ROW EXECUTE FUNCTION preserve_product_run();
COMMIT;
