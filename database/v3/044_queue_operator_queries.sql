BEGIN;
-- Operator reads and bounded Review selection use the shared queue; no history is rewritten.
CREATE INDEX queue_item_updated ON queue_item (channel, state, updated_at DESC, item_id);
CREATE INDEX queue_item_review_reason ON queue_item (channel, reason, updated_at DESC, item_id)
  WHERE state = 'review';
CREATE INDEX queue_item_source_created ON queue_item (source_id, channel, created_at);
CREATE INDEX queue_item_batch_source ON queue_item (batch_id, source_id);
CREATE INDEX brand_scan_source_latest ON brand_scan (source_id, requested_at DESC, scan_id DESC);
CREATE INDEX brand_source_channel_created ON brand_source (channel, created_at, id);
COMMIT;
