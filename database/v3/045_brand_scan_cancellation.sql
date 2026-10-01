BEGIN;

ALTER TABLE brand_scan ADD COLUMN cancellation_requested_at timestamptz;
ALTER TABLE brand_scan DROP CONSTRAINT brand_scan_state_check;
ALTER TABLE brand_scan ADD CONSTRAINT brand_scan_state_check
  CHECK (state IN ('queued', 'running', 'complete', 'partial', 'review', 'cancelled'));

-- Existing terminal-result checks and immutability trigger cover cancelled too.
-- No new tables: v3_runtime's existing SELECT/INSERT/UPDATE grant covers this column.
-- Running rows stay reclaimable for cleanup after a runner restart until acknowledged.

COMMIT;
