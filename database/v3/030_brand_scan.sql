BEGIN;
-- Brand scans (docs/spark/2026-09-28-channel-brand-adapters-plan.md, phases 3 and 6): one row per scan of one brand
-- source. A scan reads the brand's listing pages through ScraperAPI (archived in R2 under v3/brand-scans/<scan_id>/),
-- puts every listed product into the shared queue as list <scan_id>, and after a full scan queues a revisit of known
-- listings it no longer showed (list <revisit_batch_id>). Asking twice with the same request starts each scan once.

CREATE TABLE brand_scan (
  scan_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES brand_source(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('gnc', 'swanson', 'dtc', 'costco', 'wholefoods')),
  -- The listing URL as the channel's reader normalised it when the scan was requested.
  url text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 2000),
  revisit_batch_id uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'complete', 'partial', 'review')),
  -- What the finished scan found: pages, products, families, stated total, full proof, missing, queued, credits.
  result jsonb,
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]*\.[A-Z0-9_.]+$'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (request_id, source_id),
  CHECK ((state IN ('queued', 'running')) = (finished_at IS NULL)),
  CHECK ((state IN ('queued', 'running')) = (result IS NULL))
);
CREATE INDEX brand_scan_open ON brand_scan (requested_at) WHERE state IN ('queued', 'running');
CREATE INDEX brand_scan_channel ON brand_scan (channel, requested_at DESC);

-- A finished scan is history: it is never changed or removed.
CREATE FUNCTION preserve_brand_scan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.finished_at IS NOT NULL OR
    ROW(OLD.scan_id, OLD.request_id, OLD.source_id, OLD.channel, OLD.url, OLD.revisit_batch_id, OLD.requested_at)
      IS DISTINCT FROM
    ROW(NEW.scan_id, NEW.request_id, NEW.source_id, NEW.channel, NEW.url, NEW.revisit_batch_id, NEW.requested_at) THEN
    RAISE EXCEPTION 'A brand scan''s identity and finished result are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brand_scan_identity BEFORE UPDATE OR DELETE ON brand_scan
  FOR EACH ROW EXECUTE FUNCTION preserve_brand_scan();

-- The services' database role requests, claims and finishes scans; it adds brand sources (the import) but the
-- existing source tables' grants are unchanged.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON brand_scan TO v3_runtime;
  END IF;
END;
$$;
COMMIT;
