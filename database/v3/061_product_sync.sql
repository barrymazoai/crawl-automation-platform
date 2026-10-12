-- Marketplace product sync to Supply Smart (owner 2026-10-12, docs/spark/2026-10-12-marketplace-product-sync-plan.md):
-- one row per channel listing/variant says whether its current collected product is in Supply Smart. "Already
-- synced" means this ledger, not a re-read of Supply Smart; a listing is sent again only when its payload changes.
BEGIN;
SET LOCAL search_path = public;

CREATE TABLE product_sync (
  channel text NOT NULL CHECK (channel IN ('amazon', 'gnc', 'swanson', 'wholefoods', 'costco')),
  listing_id text NOT NULL CHECK (char_length(listing_id) BETWEEN 1 AND 200),
  -- '' when the listing has no website variant, so the key stays a plain primary key.
  variant_key text NOT NULL DEFAULT '' CHECK (char_length(variant_key) <= 200),
  -- present: found in Supply Smart before this ledger existed (read-only baseline); a later capture is sent again.
  -- waiting_company: the brand has no matched Supply Smart company yet. sent: an attempt began and its outcome is
  -- unknown (never resent automatically until the product settles again); verified / failed: the attempt's outcome.
  status text NOT NULL CHECK (status IN ('present', 'waiting_company', 'sent', 'verified', 'failed')),
  collected_operation_id text,
  payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^[a-f0-9]{64}$'),
  ingest_run_id text,
  supply_smart_product_id uuid,
  supply_smart_listing_id uuid,
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  -- The material (settlement) this row's outcome is about; "pending" compares it, never the write time, so a capture
  -- that settles while an older one is being sent is still picked up (review 2026-10-12). A baseline uses its time.
  material_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (channel, listing_id, variant_key),
  CHECK (status <> 'verified' OR (payload_hash IS NOT NULL AND ingest_run_id IS NOT NULL)),
  CHECK (status = 'waiting_company' OR material_at IS NOT NULL)
);
CREATE INDEX product_sync_status ON product_sync (status, channel, updated_at);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON product_sync TO v3_runtime;
  END IF;
END $$;
COMMIT;
