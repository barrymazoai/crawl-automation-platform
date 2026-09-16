BEGIN;
-- One guard row per accepted request instead of one per source. Browser channels keep source exclusivity in the
-- API (one browser session per source); request-based channels (Amazon via ScraperAPI) admit any number of
-- concurrent requests, duplicate work being prevented per listing by the recent-attempt check in the product workflow.
ALTER TABLE source_submission_guard DROP CONSTRAINT source_submission_guard_pkey;
ALTER TABLE source_submission_guard ADD CONSTRAINT source_submission_guard_pkey PRIMARY KEY (request_id);
CREATE INDEX source_submission_guard_source ON source_submission_guard (source_id);
COMMENT ON TABLE source_submission_guard IS 'One row per accepted request, released only on verified terminal evidence. Browser channels additionally allow one active request per source (enforced in the API).';
COMMIT;
