BEGIN;
-- Provider admission history, not a held resource permit. Never delete a failed/unknown
-- attempt to make room for a retry. New operations may fetch after the rolling window.
CREATE TABLE amazon_html_fetch (
  operation_id text PRIMARY KEY,
  site text NOT NULL,
  asin text NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  job jsonb NOT NULL CHECK (job->>'operationId'=operation_id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  captured_at timestamptz,
  CHECK (captured_at IS NULL OR captured_at >= requested_at - interval '5 minutes')
);
CREATE INDEX amazon_html_fetch_recent ON amazon_html_fetch(site,asin,requested_at DESC);
CREATE FUNCTION preserve_amazon_html_fetch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.captured_at IS NOT NULL OR
    ROW(OLD.operation_id,OLD.site,OLD.asin,OLD.job,OLD.requested_at) IS DISTINCT FROM
    ROW(NEW.operation_id,NEW.site,NEW.asin,NEW.job,NEW.requested_at) OR NEW.captured_at IS NULL THEN
    RAISE EXCEPTION 'Amazon HTML fetch history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER amazon_html_fetch_immutable BEFORE UPDATE OR DELETE ON amazon_html_fetch
  FOR EACH ROW EXECUTE FUNCTION preserve_amazon_html_fetch();
COMMIT;
