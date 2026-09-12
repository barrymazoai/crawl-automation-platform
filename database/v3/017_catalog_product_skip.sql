BEGIN;
-- Scope exclusions are retained outcomes, distinct from failures and Review.
CREATE TABLE catalog_product_skip (
  discovery_id text PRIMARY KEY REFERENCES catalog_discovery,
  record jsonb NOT NULL,
  record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT now(),
  CHECK((record->'receipt'->>'status' = 'skipped') IS TRUE),
  CHECK((record->'receipt'->>'reason' = 'bundle_or_pack') IS TRUE)
);
CREATE TRIGGER catalog_product_skip_immutable BEFORE UPDATE OR DELETE ON catalog_product_skip
  FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
COMMIT;
