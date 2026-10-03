BEGIN;

-- DTC discovery has its own manual intake control; product queue controls remain independent.
CREATE TABLE dtc_scan_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'paused' CHECK (mode IN ('paused', 'running')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO dtc_scan_control (singleton) VALUES (true);

-- Apply with the old scan runner drained. This also protects against concurrent API runners.
CREATE UNIQUE INDEX brand_scan_dtc_one_running ON brand_scan (channel)
  WHERE channel = 'dtc' AND state = 'running';

CREATE TABLE dtc_analysis_scan (
  analysis_id uuid NOT NULL REFERENCES dtc_site_analysis(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES brand_source(id) ON DELETE RESTRICT,
  scan_id uuid NOT NULL UNIQUE REFERENCES brand_scan(scan_id) ON DELETE RESTRICT,
  PRIMARY KEY (analysis_id, source_id)
);
COMMENT ON TABLE dtc_analysis_scan IS
  'Immutable analysis-to-brand-task handoff; each scan uses the existing product queue batch.';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, UPDATE ON dtc_scan_control TO v3_runtime;
    GRANT SELECT, INSERT ON dtc_analysis_scan TO v3_runtime;
  END IF;
END $$;
COMMIT;
