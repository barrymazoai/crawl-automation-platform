-- V3-only HTTP mutation receipts. No queue, lease, retry scheduler or legacy mapping.
BEGIN;
SET LOCAL search_path = public;
CREATE TABLE api_request_receipt (
  request_id uuid PRIMARY KEY,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 250),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE api_request_receipt IS 'A successful API mutation and its receipt commit in the same transaction; duplicates return the same result.';
COMMIT;
