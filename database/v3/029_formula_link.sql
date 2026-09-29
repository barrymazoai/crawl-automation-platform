BEGIN;
-- Sibling formula reuse (docs/spark/2026-09-28-channel-brand-adapters-plan.md, Phase 2 item 6): a product with no
-- formula of its own is linked to a size or pack-count sibling's collected formula, only after its own label was
-- checked against that formula. The link keeps the reuse visible and reversible; it is written once.

CREATE TABLE formula_link (
  -- Derived from channel, listing and variant: one link per product.
  link_id text PRIMARY KEY CHECK (link_id ~ '^[a-f0-9]{64}$'),
  channel text NOT NULL CHECK (channel IN ('amazon', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods')),
  listing_id text NOT NULL CHECK (char_length(listing_id) BETWEEN 1 AND 200),
  variant_id text CHECK (variant_id IS NULL OR char_length(variant_id) BETWEEN 1 AND 200),
  -- The collected product whose formula this product uses.
  formula_operation_id text NOT NULL CHECK (char_length(formula_operation_id) BETWEEN 1 AND 300),
  sibling_listing_id text NOT NULL CHECK (char_length(sibling_listing_id) BETWEEN 1 AND 200),
  sibling_variant_id text CHECK (sibling_variant_id IS NULL OR char_length(sibling_variant_id) BETWEEN 1 AND 200),
  -- The family as the page showed it, the compared label text and the check's name.
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  record_hash text NOT NULL CHECK (record_hash ~ '^[a-f0-9]{64}$'),
  run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (channel, listing_id, variant_id)
);
CREATE INDEX formula_link_by_listing ON formula_link (listing_id, variant_id);
CREATE FUNCTION preserve_formula_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'A formula link is immutable' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER formula_link_immutable BEFORE UPDATE OR DELETE ON formula_link
  FOR EACH ROW EXECUTE FUNCTION preserve_formula_link();

-- The services' database role may add and read, never change or remove.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT ON formula_link TO v3_runtime;
  END IF;
END;
$$;
COMMIT;
