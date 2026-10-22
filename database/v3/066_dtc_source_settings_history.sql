BEGIN;
SET LOCAL search_path = public;
CREATE TABLE dtc_source_settings_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES brand_source(id),
  analysis_id uuid NOT NULL REFERENCES dtc_site_analysis(id),
  settings jsonb NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  replaced_by_analysis_id uuid NOT NULL REFERENCES dtc_site_analysis(id),
  reason text NOT NULL
);
CREATE INDEX dtc_source_settings_history_source_time
  ON dtc_source_settings_history (source_id, replaced_at DESC, id DESC);
COMMENT ON TABLE dtc_source_settings IS 'Current verified DTC policy per source; explicit correction retains the prior row in dtc_source_settings_history.';
COMMENT ON TABLE dtc_source_settings_history IS 'Prior DTC source policies retained by owner-approved analysis reapplication.';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON dtc_source_settings TO v3_runtime;
    GRANT SELECT, INSERT ON dtc_source_settings_history TO v3_runtime;
    GRANT USAGE ON SEQUENCE dtc_source_settings_history_id_seq TO v3_runtime;
  END IF;
END $$;
COMMIT;
