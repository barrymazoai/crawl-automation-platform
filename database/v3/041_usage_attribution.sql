BEGIN;
-- Historic unknown costs remain unknown. A reused original never carries a second charge.
ALTER TABLE html_capture ADD COLUMN credit_cost numeric CHECK (credit_cost >= 0);
ALTER TABLE html_capture ADD COLUMN reused boolean NOT NULL DEFAULT false;
ALTER TABLE html_capture DISABLE TRIGGER html_capture_immutable;
UPDATE html_capture SET reused = coalesce(original->'capture'->>'operationId' <> operation_id, false),
  credit_cost = CASE WHEN original->'capture'->>'operationId' <> operation_id THEN 0 ELSE NULL END
WHERE state='done';
ALTER TABLE html_capture ENABLE TRIGGER html_capture_immutable;
CREATE INDEX html_capture_usage ON html_capture(requested_at, channel);

CREATE TABLE usage_event (
  event_id uuid PRIMARY KEY,
  channel text,
  run_id text,
  operation_id text,
  kind text NOT NULL CHECK (kind IN
    ('activity','capture','brand-request','model-text','model-image','model-enrichment','ocr','preparation')),
  step text NOT NULL,
  started_at timestamptz NOT NULL,
  duration_ms double precision NOT NULL CHECK (duration_ms >= 0 AND duration_ms < 'Infinity'::float8),
  outcome_code text NOT NULL,
  cache_hit boolean,
  provider_call boolean NOT NULL,
  credit_cost numeric CHECK (credit_cost >= 0),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  record jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT (cache_hit AND provider_call)),
  CHECK (record->>'eventId'=event_id::text)
);
CREATE INDEX usage_event_window ON usage_event(started_at,channel,kind);
CREATE INDEX usage_event_operation ON usage_event(operation_id,kind);
CREATE INDEX usage_event_run ON usage_event(run_id);
CREATE FUNCTION preserve_usage_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Usage events are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER usage_event_immutable BEFORE UPDATE OR DELETE ON usage_event
  FOR EACH ROW EXECUTE FUNCTION preserve_usage_event();

-- Migration 027 already creates and records one row per queue attempt. Extend its reporting index;
-- never recreate history from queue_item, whose previous values cannot be recovered.
CREATE INDEX queue_attempt_usage ON queue_attempt(started_at,channel);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='v3_runtime') THEN
    GRANT SELECT, INSERT ON usage_event TO v3_runtime;
    GRANT SELECT ON product_run, html_capture, queue_attempt TO v3_runtime;
  END IF;
END;
$$;
COMMIT;
