BEGIN;
-- Apply with intake paused and DTC executions drained. Historical outcomes are never rewritten/retried.
LOCK TABLE queue_item IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM queue_item WHERE channel = 'dtc'
    AND state IN ('queued', 'ready', 'running', 'following')) THEN
    RAISE EXCEPTION 'Drain DTC queue items before applying migration 047';
  END IF;
END $$;

DROP INDEX queue_one_active_listing;
CREATE UNIQUE INDEX queue_one_active_listing
  ON queue_item(channel, listing_id, coalesce(variant_id, ''),
    (CASE WHEN channel = 'dtc' THEN source_id::text ELSE '' END))
  WHERE state IN ('queued', 'ready', 'running');
CREATE INDEX queue_dtc_source_history
  ON queue_item(source_id, listing_id, coalesce(variant_id, ''), state, updated_at DESC)
  WHERE channel = 'dtc';

-- A page can match brand B while conflicting with A. Never inherit B's outcome without checking A.
CREATE OR REPLACE FUNCTION coalesce_queue_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE leader text;
BEGIN
  IF NEW.state = 'queued' THEN
    PERFORM pg_advisory_xact_lock(73110325, hashtext(NEW.channel));
    SELECT item_id INTO leader FROM queue_item
      WHERE channel = NEW.channel AND listing_id = NEW.listing_id
        AND (NEW.channel <> 'dtc' OR source_id = NEW.source_id)
        AND variant_id IS NOT DISTINCT FROM NEW.variant_id AND item_id <> NEW.item_id
        AND state IN ('queued', 'ready', 'running') LIMIT 1;
    NEW.follows_item_id := leader;
    IF leader IS NOT NULL THEN NEW.state := 'following'; END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
