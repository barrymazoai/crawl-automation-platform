BEGIN;

-- Never delete claims to retry a failed model call. Unknown executions require manual review.
CREATE TABLE product_enrichment_attempt (
  input_hash text PRIMARY KEY CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  protocol text NOT NULL,
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER product_enrichment_attempt_immutable BEFORE UPDATE OR DELETE
  ON product_enrichment_attempt FOR EACH ROW EXECUTE FUNCTION product_history_reject_change();

-- Each product keeps its own title/provenance, even when the model answer is reused by input hash.
CREATE TABLE product_enrichment_subject (
  subject_id text PRIMARY KEY CHECK (subject_id ~ '^[a-f0-9]{64}$'),
  enrichment_id text NOT NULL REFERENCES product_enrichment(enrichment_id),
  channel text NOT NULL,
  listing_id text NOT NULL,
  variant_id text,
  collection_operation_id text NOT NULL REFERENCES collected_product(operation_id),
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX product_enrichment_subject_lookup ON product_enrichment_subject
  (channel, listing_id, variant_id, collection_operation_id);
CREATE TRIGGER product_enrichment_subject_immutable BEFORE UPDATE OR DELETE
  ON product_enrichment_subject FOR EACH ROW EXECUTE FUNCTION product_history_reject_change();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT ON product_enrichment_attempt, product_enrichment_subject,
      product_enrichment TO v3_runtime;
  END IF;
END $$;
COMMIT;
