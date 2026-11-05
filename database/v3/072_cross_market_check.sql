BEGIN;
-- KAN-243 (owner 2026-11-05): the cross-market check of an Amazon storefront's listing against the same ASIN's
-- listing on another storefront in Supply Smart, before the listing is first sent. Append-only: every outcome is
-- kept, the newest per (channel, listing, collected label, compared listing) is in force. `pending` waits for the
-- other storefront's recaptured page; `unjudged` sends no verdict and keeps why; `decided` keeps the verdict sent.
CREATE TABLE cross_market_check (
  check_id bigserial PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('amazon', 'amazon-in')),
  listing_id text NOT NULL CHECK (length(listing_id) BETWEEN 1 AND 200),
  collection_operation_id text NOT NULL CHECK (length(collection_operation_id) BETWEEN 1 AND 500),
  compared_listing_id text NOT NULL CHECK (length(compared_listing_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('pending', 'unjudged', 'decided')),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 100),
  field jsonb,
  recorded_at timestamptz NOT NULL,
  CHECK ((status = 'decided') = (field IS NOT NULL)),
  CHECK ((status = 'unjudged') = (reason IS NOT NULL))
);
CREATE INDEX cross_market_check_key
  ON cross_market_check (channel, listing_id, collection_operation_id, compared_listing_id, check_id DESC);

-- Append-only for the runtime: no UPDATE or DELETE.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT ON cross_market_check TO v3_runtime;
    GRANT USAGE ON SEQUENCE cross_market_check_check_id_seq TO v3_runtime;
  END IF;
END $$;
COMMIT;
