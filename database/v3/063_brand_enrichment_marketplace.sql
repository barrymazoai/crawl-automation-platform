-- Marketplace brands without a Supply Smart company (owner 2026-10-15): a brand-enrichment run started from one of
-- our own brands instead of a Supply Smart request. It finds the official website, then the usual identity rule
-- finds or creates the company, and the brand's waiting products follow through the product sync.
BEGIN;
SET LOCAL search_path = public;

ALTER TABLE brand_enrichment_run DROP CONSTRAINT brand_enrichment_run_role_check;
ALTER TABLE brand_enrichment_run ADD CONSTRAINT brand_enrichment_run_role_check
  CHECK (role IN ('request', 'sub_brand', 'owner', 'marketplace'));

ALTER TABLE brand_enrichment_run ADD COLUMN brand_id uuid REFERENCES brand(id) ON DELETE RESTRICT;
ALTER TABLE brand_enrichment_run ADD CONSTRAINT brand_enrichment_run_marketplace CHECK (
  (role = 'marketplace') = (brand_id IS NOT NULL) AND (role <> 'marketplace' OR parent_run_id IS NULL)
);
-- One live run per brand.
CREATE UNIQUE INDEX brand_enrichment_run_live_brand
  ON brand_enrichment_run (brand_id) WHERE state IN ('running', 'waiting_for_person');

COMMIT;
