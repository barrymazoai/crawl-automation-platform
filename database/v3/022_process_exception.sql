BEGIN;
-- Every unexpected exception in the crawl process, whatever the product's final outcome: a step that threw (even if a
-- retry later succeeded), or a product workflow that ended without a terminal record and was sent to review.
-- Recording is best-effort and never affects the product; rows are only ever added.
CREATE TABLE process_exception (
  exception_id text PRIMARY KEY CHECK (exception_id ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind IN ('activity','product')),
  service text NOT NULL,
  workflow_type text,
  workflow_id text,
  run_id text,
  activity text,
  attempt integer,
  request_id text,
  listing_id text,
  code text NOT NULL,
  error_name text,
  message text NOT NULL,
  outcome text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX process_exception_time_idx ON process_exception (occurred_at);
CREATE INDEX process_exception_listing_idx ON process_exception (listing_id, occurred_at);
CREATE INDEX process_exception_code_idx ON process_exception (code, occurred_at);
COMMIT;
