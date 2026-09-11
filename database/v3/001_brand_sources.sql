-- Fresh V3 BUSINESS database only. Not the old crawler DB or Temporal's DB.
-- This defines the first schema; it does not import or transform legacy data.
BEGIN;
SET LOCAL search_path = public;

CREATE TABLE brand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  note text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT brand_name_valid CHECK (
    char_length(name) BETWEEN 1 AND 80
    AND name !~ '^[[:space:]]|[[:space:]]$'
  ),
  CONSTRAINT brand_note_length CHECK (char_length(note) <= 2000)
);
CREATE UNIQUE INDEX brand_name_unique ON brand (lower(name));

CREATE TABLE brand_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brand(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('amazon', 'gnc', 'swanson', 'dtc')),
  region text NOT NULL DEFAULT 'US' CHECK (region ~ '^[A-Z]{2}$'),
  url text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT brand_source_url_shape CHECK (
    octet_length(url) BETWEEN 10 AND 2000
    AND url ~ '^https?://[^/?#[:space:]@]+([/?][^#[:space:]]*)?$'
  ),
  CONSTRAINT brand_source_unique UNIQUE (brand_id, region, url)
);
CREATE INDEX brand_source_enabled_channel ON brand_source (channel, region) WHERE enabled;

-- Revision is a concurrency token, not a workflow/job state.
-- API updates must use WHERE id = $id AND revision = $expected_revision.
CREATE FUNCTION touch_brand_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Record identity and creation time are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'brand_source' THEN
    IF NEW.brand_id IS DISTINCT FROM OLD.brand_id THEN
      RAISE EXCEPTION 'A source cannot be reassigned to another Brand' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER brand_touch BEFORE UPDATE ON brand
  FOR EACH ROW EXECUTE FUNCTION touch_brand_record();
CREATE TRIGGER brand_source_touch BEFORE UPDATE ON brand_source
  FOR EACH ROW EXECUTE FUNCTION touch_brand_record();

COMMENT ON TABLE brand IS 'V3-owned brand identity. No legacy ID or formal company is required.';
COMMENT ON TABLE brand_source IS 'Brand entry links; configuration only, not a work queue.';
COMMENT ON COLUMN brand_source.enabled IS 'May be selected for future collection; enabling does not itself submit a task.';
COMMENT ON COLUMN brand_source.url IS 'API must parse/canonicalize URL; this DB check is not SSRF protection or site verification.';

COMMIT;
