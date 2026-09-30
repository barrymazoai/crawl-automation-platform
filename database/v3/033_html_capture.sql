BEGIN;
-- Shared HTML admission history, not a held processing-resource permit. Failed operations
-- never retry themselves. Only a saved original's capture time starts the 24-hour window.
CREATE TABLE html_capture (
  operation_id text PRIMARY KEY,
  channel text NOT NULL,
  listing_id text NOT NULL,
  variant_id text,
  request jsonb NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight','done','failed')),
  captured_at timestamptz,
  original jsonb,
  cause_code text,
  CHECK (request->>'channel' IS NOT DISTINCT FROM channel),
  CHECK (request->'capture'->>'operationId' IS NOT DISTINCT FROM operation_id),
  CHECK (request->'capture'->>'listingId' IS NOT DISTINCT FROM listing_id),
  CHECK (request->'capture'->>'variantId' IS NOT DISTINCT FROM variant_id),
  CHECK (
    (state='done' AND original IS NOT NULL AND captured_at IS NOT NULL AND cause_code IS NULL) OR
    (state='in_flight' AND original IS NULL AND captured_at IS NULL AND cause_code IS NULL) OR
    (state='failed' AND original IS NULL AND captured_at IS NULL)
  ),
  CHECK (original IS NULL OR (
    original->>'channel' IS NOT DISTINCT FROM channel AND
    original->'capture'->>'listingId' IS NOT DISTINCT FROM listing_id AND
    original->'capture'->>'variantId' IS NOT DISTINCT FROM variant_id AND
    (original->>'capturedAt')::timestamptz IS NOT DISTINCT FROM captured_at
  ))
);
CREATE INDEX html_capture_recent ON html_capture(channel,listing_id,variant_id,captured_at DESC)
  WHERE state='done';
CREATE INDEX html_capture_in_flight ON html_capture(channel,listing_id,variant_id,requested_at DESC)
  WHERE state='in_flight';
CREATE FUNCTION preserve_html_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.state<>'in_flight' OR
    ROW(OLD.operation_id,OLD.channel,OLD.listing_id,OLD.variant_id,OLD.request,OLD.requested_at)
      IS DISTINCT FROM
    ROW(NEW.operation_id,NEW.channel,NEW.listing_id,NEW.variant_id,NEW.request,NEW.requested_at) OR
    NEW.state NOT IN ('done','failed') THEN
    RAISE EXCEPTION 'HTML capture history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER html_capture_immutable BEFORE UPDATE OR DELETE ON html_capture
  FOR EACH ROW EXECUTE FUNCTION preserve_html_capture();
COMMIT;
