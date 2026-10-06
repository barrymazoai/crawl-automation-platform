-- Queue priority per brand source (owner 2026-10-06, CRAWLV3-210): a source's queued products start before older
-- products of lower-priority sources; equal priority keeps oldest first. No row, or 0, is normal order.
BEGIN;
SET LOCAL search_path=public;
CREATE TABLE queue_source_priority (
  channel text NOT NULL REFERENCES queue_control(channel),
  source_id uuid NOT NULL REFERENCES brand_source(id) ON DELETE RESTRICT,
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (channel, source_id)
);
COMMENT ON TABLE queue_source_priority IS 'Queue order per brand source: higher priority starts first; no row means 0.';
COMMIT;
