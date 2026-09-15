BEGIN;
-- Append-only enrichment results: unified product name, base name, variant attributes, dosage form and
-- health functions derived once per (listing, formula content, protocol). A matching row means the model
-- is not called again for that product until its formula content or the protocol changes.
CREATE TABLE product_enrichment (
  enrichment_id text PRIMARY KEY CHECK (enrichment_id ~ '^[a-f0-9]{64}$'),
  listing_id text NOT NULL,
  formula_hash text NOT NULL CHECK (formula_hash ~ '^[a-f0-9]{64}$'),
  protocol text NOT NULL,
  collection_operation_id text NOT NULL,
  record_hash text NOT NULL CHECK (record_hash ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX product_enrichment_listing_idx ON product_enrichment (listing_id, protocol);
CREATE INDEX product_enrichment_collection_idx ON product_enrichment (collection_operation_id);
CREATE TRIGGER product_enrichment_immutable BEFORE UPDATE OR DELETE ON product_enrichment FOR EACH ROW EXECUTE FUNCTION product_history_reject_change();
COMMIT;
