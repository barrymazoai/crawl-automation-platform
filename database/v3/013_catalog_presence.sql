BEGIN;
-- Evidence ledger, not a second job scheduler. Temporal remains the task owner.
CREATE TABLE catalog_run (
  catalog_id text PRIMARY KEY, scope jsonb NOT NULL, scope_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_page (
  catalog_id text NOT NULL REFERENCES catalog_run, page_index integer NOT NULL CHECK(page_index>=0),
  page_hash text NOT NULL, record jsonb NOT NULL, registered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(catalog_id,page_index)
);
CREATE TABLE catalog_discovery (
  discovery_id text PRIMARY KEY, catalog_id text NOT NULL REFERENCES catalog_run,
  listing_id text NOT NULL, variant_key text NOT NULL, record jsonb NOT NULL,
  first_page integer NOT NULL, discovered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(catalog_id,listing_id,variant_key)
);
CREATE TABLE catalog_dispatch (
  discovery_id text PRIMARY KEY REFERENCES catalog_discovery, execution jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_closure (
  catalog_id text PRIMARY KEY REFERENCES catalog_run, status text NOT NULL CHECK(status IN ('complete','incomplete')),
  record jsonb NOT NULL, record_hash text NOT NULL, closed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE presence_result (
  operation_id text PRIMARY KEY, catalog_id text NOT NULL REFERENCES catalog_run,
  record jsonb NOT NULL, record_hash text NOT NULL, registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE observation_execution (
  observation_id text NOT NULL, execution jsonb NOT NULL, registered_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(observation_id,execution)
);
CREATE FUNCTION catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Catalog evidence is immutable'; END $$;
CREATE TRIGGER catalog_run_immutable BEFORE UPDATE OR DELETE ON catalog_run FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
CREATE TRIGGER catalog_page_immutable BEFORE UPDATE OR DELETE ON catalog_page FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
CREATE TRIGGER catalog_discovery_immutable BEFORE UPDATE OR DELETE ON catalog_discovery FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
CREATE TRIGGER catalog_dispatch_immutable BEFORE UPDATE OR DELETE ON catalog_dispatch FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
CREATE TRIGGER catalog_closure_immutable BEFORE UPDATE OR DELETE ON catalog_closure FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
CREATE TRIGGER presence_result_immutable BEFORE UPDATE OR DELETE ON presence_result FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
CREATE TRIGGER observation_execution_immutable BEFORE UPDATE OR DELETE ON observation_execution FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
CREATE INDEX catalog_scope ON catalog_run(scope_hash);
CREATE INDEX catalog_discovery_catalog ON catalog_discovery(catalog_id);
CREATE INDEX processing_result_observation ON processing_result((coalesce(record->'input'->>'observationId',record->'input'->'input'->'selection'->'observation'->>'observationId')));
COMMIT;
