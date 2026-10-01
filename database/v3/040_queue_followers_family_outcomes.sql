BEGIN;
-- Apply with intake paused. Never relabel an already running execution as an unstarted follower.
LOCK TABLE queue_item IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM queue_item WHERE state = 'running'
    GROUP BY channel, listing_id, coalesce(variant_id, '') HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Drain duplicate running queue items before applying migration 040';
  END IF;
END $$;

ALTER TABLE queue_item ADD COLUMN follows_item_id text REFERENCES queue_item(item_id);
ALTER TABLE queue_item DROP CONSTRAINT queue_item_state_check;
ALTER TABLE queue_item ADD CONSTRAINT queue_item_state_check
  CHECK (state IN ('queued', 'ready', 'running', 'following', 'pending', 'completed', 'review'));
ALTER TABLE queue_item DROP CONSTRAINT queue_item_check;
ALTER TABLE queue_item ADD CONSTRAINT queue_item_check
  CHECK ((state IN ('queued', 'ready', 'following')) = (run_id IS NULL));
ALTER TABLE queue_item ADD CONSTRAINT queue_follower_identity
  CHECK (follows_item_id IS DISTINCT FROM item_id AND (state <> 'following' OR follows_item_id IS NOT NULL));
ALTER TABLE queue_attempt DROP CONSTRAINT queue_attempt_outcome_check;
ALTER TABLE queue_attempt ADD CONSTRAINT queue_attempt_outcome_check
  CHECK (outcome IN ('running', 'completed', 'review', 'pending'));

-- Preserve every batch request and attempt. Terminal rows are not candidates for this index
-- or the backfill: the production 30 review+queued and 2 completed+queued pairs stay unchanged
-- (all 32 queued requests remain eligible; their 32 historical terminal rows/attempts remain).
-- For multiple active rows, prefer the sole running item, then oldest created_at, then item_id.
-- Only the other queued/ready rows become followers; no attempt/run/receipt is deleted or started.
WITH ranked AS (
  SELECT item_id, first_value(item_id) OVER (
    PARTITION BY channel, listing_id, coalesce(variant_id, '')
    ORDER BY (state = 'running') DESC, created_at, item_id) AS leader
  FROM queue_item WHERE state IN ('queued', 'ready', 'running')
)
UPDATE queue_item item SET state = 'following', follows_item_id = ranked.leader,
  updated_at = clock_timestamp()
FROM ranked WHERE item.item_id = ranked.item_id AND ranked.item_id <> ranked.leader;
CREATE UNIQUE INDEX queue_one_active_listing
  ON queue_item(channel, listing_id, coalesce(variant_id, ''))
  WHERE state IN ('queued', 'ready', 'running');
CREATE INDEX queue_followers ON queue_item(follows_item_id) WHERE state = 'following';

-- The same lock as the queue service/dispatcher. Covers inserts and explicit owner requeues.
CREATE FUNCTION coalesce_queue_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE leader text;
BEGIN
  IF NEW.state = 'queued' THEN
    PERFORM pg_advisory_xact_lock(73110325, hashtext(NEW.channel));
    SELECT item_id INTO leader FROM queue_item
      WHERE channel = NEW.channel AND listing_id = NEW.listing_id
        AND variant_id IS NOT DISTINCT FROM NEW.variant_id AND item_id <> NEW.item_id
        AND state IN ('queued', 'ready', 'running') LIMIT 1;
    NEW.follows_item_id := leader;
    IF leader IS NOT NULL THEN NEW.state := 'following'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER queue_request_coalescing BEFORE INSERT OR UPDATE OF state ON queue_item
  FOR EACH ROW EXECUTE FUNCTION coalesce_queue_request();

-- Followers inherit a terminal receipt, never an invented queue_attempt or another paid operation.
CREATE FUNCTION settle_queue_followers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'running' AND NEW.state IN ('completed', 'review', 'pending') THEN
    UPDATE queue_item SET state = NEW.state, run_id = NEW.run_id, reason = NEW.reason,
      updated_at = clock_timestamp()
    WHERE state = 'following' AND follows_item_id = NEW.item_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER queue_follower_settlement AFTER UPDATE OF state ON queue_item
  FOR EACH ROW EXECUTE FUNCTION settle_queue_followers();

-- A separate receipt for metrics and the formula dependency; workflow completion is not label completion.
CREATE TABLE family_formula_outcome (
  operation_id text PRIMARY KEY,
  run_id uuid NOT NULL,
  brand_id uuid NOT NULL REFERENCES brand(id),
  channel text NOT NULL CHECK (channel = 'wholefoods'),
  listing_id text NOT NULL,
  variant_id text,
  archive_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('metrics-complete', 'formula-pending', 'no-amazon-source', 'formula-linked')),
  formula_operation_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'formula-linked') = (formula_operation_id IS NOT NULL))
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON family_formula_outcome TO v3_runtime;
  END IF;
END $$;
COMMIT;
