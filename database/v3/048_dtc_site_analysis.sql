BEGIN;
SET LOCAL search_path = public;
CREATE TABLE dtc_site_analysis (
  id uuid PRIMARY KEY,
  url text NOT NULL,
  limits jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','completed','needs-review','failed')),
  brands jsonb NOT NULL DEFAULT '[]',
  archive_keys jsonb NOT NULL DEFAULT '[]',
  reasons jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE dtc_source_settings (
  source_id uuid PRIMARY KEY REFERENCES brand_source(id) ON DELETE RESTRICT,
  analysis_id uuid NOT NULL REFERENCES dtc_site_analysis(id) ON DELETE RESTRICT,
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE dtc_source_settings IS 'Verified DTC policy per source; immutable on apply, catalog belongs to the verified child domain.';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON dtc_site_analysis TO v3_runtime;
    GRANT SELECT, INSERT ON dtc_source_settings TO v3_runtime;
  END IF;
END $$;
COMMIT;
