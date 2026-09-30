BEGIN;
-- R13: the shared dispatcher owns all new Amazon work. Retire the legacy runner before applying this
-- migration. Its tables remain untouched history; neither queue's mode or limits change here.
-- Take both writers' locks so the snapshot cannot race a claim or a shared Amazon queue mutation.
SELECT pg_advisory_xact_lock(73110324);
SELECT pg_advisory_xact_lock(73110325, hashtext('amazon'));
LOCK TABLE amazon_queue_item, amazon_queue_attempt IN SHARE MODE;

-- A requeued failure may look pending but has already started: require zero attempts AND no history.
-- Fail atomically on a malformed legacy item or foreign source rather than silently losing a product.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM amazon_queue_item i
    LEFT JOIN brand_source s ON s.id::text = i.input->'scope'->>'sourceId'
    WHERE i.state IN ('queued', 'ready') AND i.attempt = 0 AND i.request_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM amazon_queue_attempt a WHERE a.item_id = i.item_id)
      AND NOT EXISTS (SELECT 1 FROM queue_item q WHERE q.item_id = i.item_id)
      AND (s.channel IS DISTINCT FROM 'amazon'
        OR i.input->'scope'->>'channel' IS DISTINCT FROM 'amazon'
        OR jsonb_array_length(i.input->'entries') IS DISTINCT FROM 1)
  ) THEN
    RAISE EXCEPTION 'Pending Amazon migration item has an invalid source or entry count'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- One immutable list per legacy item avoids campaign size limits and preserves a stable mapping on reruns.
-- Keep the old item_id as the copy marker, even after its shared attempt has settled or been requeued.
WITH pending AS (
  SELECT i.*, md5('amazon-queue-migration:' || i.item_id)::uuid AS batch_id
  FROM amazon_queue_item i
  WHERE i.state IN ('queued', 'ready') AND i.attempt = 0 AND i.request_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM amazon_queue_attempt a WHERE a.item_id = i.item_id)
    AND NOT EXISTS (SELECT 1 FROM queue_item q WHERE q.item_id = i.item_id)
), batches AS (
  INSERT INTO link_batch (batch_id, channel, label, item_count, record_hash, created_at)
  SELECT batch_id, 'amazon', left('Legacy Amazon: ' || campaign_id, 200), 1,
    encode(sha256(convert_to(input::text, 'UTF8')), 'hex'), created_at FROM pending
  ON CONFLICT DO NOTHING
  RETURNING batch_id
)
INSERT INTO queue_item (item_id, channel, batch_id, source_id, url, listing_id, variant_id, created_at)
SELECT item_id, 'amazon', batch_id, (input->'scope'->>'sourceId')::uuid,
  input->'entries'->0->'entry'->>'url', input->'entries'->0->'entry'->>'listingId',
  input->'entries'->0->'entry'->>'variantId', created_at
FROM pending
ON CONFLICT DO NOTHING;
-- Every copied item starts queued/attempt 0 with no run, independent of its old ready status.
-- No attempts or completed/Review history are copied, and no workflow is started by this migration.
COMMIT;
