BEGIN;
-- Imported authorizations remain immutable even when the queue advances or is replayed.
CREATE TABLE amazon_link_batch (
  request_id uuid PRIMARY KEY,
  record jsonb NOT NULL CHECK (record->>'codec'='amazon-link-batch/1' AND record->>'requestId'=request_id::text
    AND jsonb_array_length(record->'entries') BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION preserve_amazon_link_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Amazon link authorization is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER amazon_link_batch_immutable BEFORE UPDATE OR DELETE ON amazon_link_batch
  FOR EACH ROW EXECUTE FUNCTION preserve_amazon_link_batch();

-- A queue slot is one product, not a ten-product request. New attempts get new IDs.
CREATE TABLE amazon_queue_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'paused' CHECK (mode IN ('running','paused','draining','stopping')),
  ready_limit integer NOT NULL DEFAULT 20 CHECK (ready_limit BETWEEN 1 AND 1000),
  running_limit integer NOT NULL DEFAULT 80 CHECK (running_limit BETWEEN 1 AND 1000),
  force_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO amazon_queue_control(singleton) VALUES(true);
CREATE TABLE amazon_queue_item (
  item_id text PRIMARY KEY CHECK (item_id ~ '^[a-f0-9]{64}$'),
  campaign_id text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','ready','running','completed','review')),
  attempt integer NOT NULL DEFAULT 0,
  request_id uuid,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX amazon_queue_item_next ON amazon_queue_item(state,next_check_at,created_at,item_id);
CREATE TABLE amazon_queue_attempt (
  request_id uuid PRIMARY KEY REFERENCES amazon_link_batch(request_id),
  item_id text NOT NULL REFERENCES amazon_queue_item(item_id),
  attempt integer NOT NULL CHECK (attempt > 0),
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running','completed','review','interrupted')),
  proof jsonb,
  stop_requested_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE(item_id,attempt),
  CHECK ((outcome='running' AND settled_at IS NULL) OR (outcome<>'running' AND settled_at IS NOT NULL AND proof IS NOT NULL))
);
CREATE FUNCTION preserve_amazon_queue_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.settled_at IS NOT NULL OR
    ROW(OLD.request_id,OLD.item_id,OLD.attempt,OLD.started_at) IS DISTINCT FROM
    ROW(NEW.request_id,NEW.item_id,NEW.attempt,NEW.started_at) THEN
    RAISE EXCEPTION 'Amazon queue attempt history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER amazon_queue_attempt_identity BEFORE UPDATE OR DELETE ON amazon_queue_attempt
  FOR EACH ROW EXECUTE FUNCTION preserve_amazon_queue_attempt();
COMMIT;
