-- Stable, bounded handoff scan. No job queue/claim/lease or mutable scheduling state.
BEGIN;
SET LOCAL search_path = public;
CREATE INDEX collection_submission_scan_order ON collection_submission(created_at, request_id);
COMMIT;
