BEGIN;
-- One product queue for every channel (docs/spark/2026-09-28-channel-brand-adapters-plan.md: "One shared queue with
-- a channel column. Amazon's existing queue stays untouched"). The API process dispatches it: queued -> ready ->
-- running within each channel's own limits; every start is a product run; nothing is retried automatically.

ALTER TABLE brand_source DROP CONSTRAINT brand_source_channel_check;
ALTER TABLE brand_source ADD CONSTRAINT brand_source_channel_check
  CHECK (channel IN ('amazon', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

-- One row per channel. Every channel starts paused: nothing runs until someone resumes it.
CREATE TABLE queue_control (
  channel text PRIMARY KEY CHECK (channel IN ('amazon', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods')),
  mode text NOT NULL DEFAULT 'paused' CHECK (mode IN ('running', 'paused', 'draining', 'stopping')),
  ready_limit integer NOT NULL DEFAULT 20 CHECK (ready_limit BETWEEN 1 AND 1000),
  running_limit integer NOT NULL DEFAULT 40 CHECK (running_limit BETWEEN 1 AND 1000),
  force_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO queue_control (channel)
  VALUES ('amazon'), ('gnc'), ('swanson'), ('dtc'), ('costco'), ('wholefoods');

-- A product list as it was added (a brand scan's result, or a list given by hand). Immutable.
CREATE TABLE link_batch (
  batch_id uuid PRIMARY KEY,
  channel text NOT NULL REFERENCES queue_control(channel),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 10000),
  record_hash text NOT NULL CHECK (record_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION preserve_link_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'A product list is immutable once added' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER link_batch_immutable BEFORE UPDATE OR DELETE ON link_batch
  FOR EACH ROW EXECUTE FUNCTION preserve_link_batch();

-- One product of one list. Its ID is stable, so adding the same list again adds nothing.
CREATE TABLE queue_item (
  item_id text PRIMARY KEY CHECK (item_id ~ '^[a-f0-9]{64}$'),
  channel text NOT NULL REFERENCES queue_control(channel),
  batch_id uuid NOT NULL REFERENCES link_batch(batch_id),
  source_id uuid NOT NULL REFERENCES brand_source(id) ON DELETE RESTRICT,
  url text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 4096),
  listing_id text NOT NULL CHECK (char_length(listing_id) BETWEEN 1 AND 200),
  variant_id text CHECK (variant_id IS NULL OR char_length(variant_id) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'ready', 'running', 'completed', 'review')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  -- The product run of the current attempt (its request ID); null until started, cleared by a requeue.
  run_id uuid,
  -- For Review items: the failure's code.
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Not yet started means no run; started (running or finished) means exactly one.
  CHECK ((state IN ('queued', 'ready')) = (run_id IS NULL))
);
CREATE INDEX queue_item_next ON queue_item (channel, state, created_at, item_id);

-- Every start of an item, kept forever. A new attempt is only ever started by a requeue.
CREATE TABLE queue_attempt (
  run_id uuid PRIMARY KEY,
  item_id text NOT NULL REFERENCES queue_item(item_id),
  channel text NOT NULL REFERENCES queue_control(channel),
  attempt integer NOT NULL CHECK (attempt > 0),
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'completed', 'review')),
  reason text,
  stop_requested_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (item_id, attempt),
  CHECK ((outcome = 'running' AND settled_at IS NULL) OR (outcome <> 'running' AND settled_at IS NOT NULL))
);
CREATE FUNCTION preserve_queue_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.settled_at IS NOT NULL OR
    ROW(OLD.run_id, OLD.item_id, OLD.channel, OLD.attempt, OLD.started_at) IS DISTINCT FROM
    ROW(NEW.run_id, NEW.item_id, NEW.channel, NEW.attempt, NEW.started_at) THEN
    RAISE EXCEPTION 'Queue attempt history is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER queue_attempt_identity BEFORE UPDATE OR DELETE ON queue_attempt
  FOR EACH ROW EXECUTE FUNCTION preserve_queue_attempt();

-- The services' database role: lists are added, never changed; items and attempts move through their states; each
-- channel's control row is seeded here and only updated afterwards.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, UPDATE ON queue_control TO v3_runtime;
    GRANT SELECT, INSERT ON link_batch TO v3_runtime;
    GRANT SELECT, INSERT, UPDATE ON queue_item, queue_attempt TO v3_runtime;
  END IF;
END;
$$;
COMMIT;
