BEGIN;
CREATE TABLE catalog_product_input (
  discovery_id text PRIMARY KEY REFERENCES catalog_discovery,
  record jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER catalog_product_input_immutable BEFORE UPDATE OR DELETE ON catalog_product_input
  FOR EACH ROW EXECUTE FUNCTION catalog_immutable();
COMMIT;
