-- DTC site analyses may end as skipped (owner 2026-10-08): the site sells no nutrition products, so nothing is applied.
BEGIN;
ALTER TABLE dtc_site_analysis DROP CONSTRAINT dtc_site_analysis_state_check;
ALTER TABLE dtc_site_analysis ADD CONSTRAINT dtc_site_analysis_state_check
  CHECK (state = ANY (ARRAY['queued', 'running', 'completed', 'needs-review', 'failed', 'skipped']));
COMMIT;
