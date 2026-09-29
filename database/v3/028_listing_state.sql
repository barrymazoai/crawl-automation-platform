BEGIN;
-- Listing states (docs/quality/2026-09-18-product-service-listing-state-prompt.md): what a direct revisit of a known
-- listing showed: unlisted, with exactly why, or live. Owner rule 2026-09-29, every channel: a page that no longer
-- exists, redirects to a different product, redirects to no product, or shows another product's ID is unlisted.
-- Each sighting is a fact written once. The crawler never marks a listing delisted; the product database decides.

CREATE TABLE listing_state_observation (
  -- Derived from channel, listing, variant and the source that saw it, so recording twice records once.
  observation_id text PRIMARY KEY CHECK (observation_id ~ '^[a-f0-9]{64}$'),
  channel text NOT NULL CHECK (channel IN ('amazon', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods')),
  listing_id text NOT NULL CHECK (char_length(listing_id) BETWEEN 1 AND 200),
  variant_id text CHECK (variant_id IS NULL OR char_length(variant_id) BETWEEN 1 AND 200),
  brand_id uuid,
  run_id uuid,
  state text NOT NULL CHECK (state IN ('unlisted', 'live')),
  reason text CHECK (reason IN ('not_found', 'redirected_to_other_product', 'redirected_away', 'identity_conflict')),
  -- probe, causeCode, httpStatus, observedExternalId, finalUrl, artifactKey.
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 300),
  captured_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- An unlisted listing always says why; a live one never has a reason.
  CHECK ((state = 'unlisted') = (reason IS NOT NULL)),
  -- Each reason carries its evidence: the status of a missing page, the other product and where a redirect landed.
  CHECK (reason IS DISTINCT FROM 'not_found' OR evidence->>'httpStatus' IN ('404', '410')),
  CHECK (reason NOT IN ('redirected_to_other_product', 'identity_conflict')
    OR coalesce(evidence->>'observedExternalId', '') <> ''),
  CHECK (reason NOT IN ('redirected_to_other_product', 'redirected_away')
    OR coalesce(evidence->>'finalUrl', '') <> '')
);
CREATE INDEX listing_state_by_listing
  ON listing_state_observation (channel, listing_id, variant_id, captured_at DESC);
CREATE INDEX listing_state_by_brand ON listing_state_observation (channel, brand_id, captured_at DESC);
CREATE INDEX listing_state_by_reason ON listing_state_observation (channel, reason, captured_at DESC)
  WHERE reason IS NOT NULL;
CREATE FUNCTION preserve_listing_state_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'A listing state observation is immutable' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER listing_state_observation_immutable BEFORE UPDATE OR DELETE ON listing_state_observation
  FOR EACH ROW EXECUTE FUNCTION preserve_listing_state_observation();

-- The product database's final answer for a sighting it accepted. A sighting without a row here is still to be
-- sent; a failed send writes nothing, so the sighting is sent again later.
CREATE TABLE listing_state_delivery (
  observation_id text PRIMARY KEY REFERENCES listing_state_observation(observation_id),
  status text NOT NULL CHECK (status IN ('ok', 'unknown_listing')),
  response jsonb NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION preserve_listing_state_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'A listing state delivery is immutable' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER listing_state_delivery_immutable BEFORE UPDATE OR DELETE ON listing_state_delivery
  FOR EACH ROW EXECUTE FUNCTION preserve_listing_state_delivery();

-- The services' database role may add and read, never change or remove.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT ON listing_state_observation, listing_state_delivery TO v3_runtime;
  END IF;
END;
$$;
COMMIT;
