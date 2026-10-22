BEGIN;
-- A withdrawn request remains a listing and keeps every historical attempt. It has no current run.
ALTER TABLE queue_item DROP CONSTRAINT queue_item_state_check;
ALTER TABLE queue_item ADD CONSTRAINT queue_item_state_check
  CHECK (state IN ('queued', 'ready', 'running', 'following', 'pending', 'completed', 'review', 'withdrawn'));
ALTER TABLE queue_item DROP CONSTRAINT queue_item_check;
ALTER TABLE queue_item ADD CONSTRAINT queue_item_check
  CHECK ((state IN ('queued', 'ready', 'following', 'withdrawn')) = (run_id IS NULL));
ALTER TABLE queue_item ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE queue_item ADD COLUMN withdraw_note text CHECK (withdraw_note IS NULL OR char_length(withdraw_note) BETWEEN 1 AND 200);
ALTER TABLE queue_item ADD CONSTRAINT queue_withdrawn_receipt
  CHECK (state <> 'withdrawn' OR (reason IS NOT DISTINCT FROM 'QUEUE.WITHDRAWN' AND withdrawn_at IS NOT NULL));

-- Extend the existing follower settlement trigger: a withdrawn, unstarted leader releases one surviving
-- follower as the new leader. The queue's existing coalescing trigger checks that promotion and the others
-- continue to follow it. A running leader still settles followers through the original branch.
CREATE OR REPLACE FUNCTION settle_queue_followers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE promoted text;
BEGIN
  IF OLD.state = 'running' AND NEW.state IN ('completed', 'review', 'pending') THEN
    UPDATE queue_item SET state = NEW.state, run_id = NEW.run_id, reason = NEW.reason,
      updated_at = clock_timestamp()
    WHERE state = 'following' AND follows_item_id = NEW.item_id;
  ELSIF OLD.state IN ('queued', 'ready') AND NEW.state = 'withdrawn' THEN
    SELECT item_id INTO promoted FROM queue_item
      WHERE state = 'following' AND follows_item_id = NEW.item_id
      ORDER BY created_at, item_id LIMIT 1;
    IF promoted IS NOT NULL THEN
      UPDATE queue_item SET state = 'queued', follows_item_id = NULL, updated_at = clock_timestamp()
        WHERE item_id = promoted AND state = 'following';
      UPDATE queue_item SET follows_item_id = promoted, updated_at = clock_timestamp()
        WHERE state = 'following' AND follows_item_id = NEW.item_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
