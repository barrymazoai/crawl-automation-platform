BEGIN;
-- The terminal queue row's updated_at is its settlement time (including settled followers).
-- Lookup is by channel/SKU, never by brand source, URL or scan batch.
CREATE INDEX queue_scan_listing_history
  ON queue_item(channel, listing_id, coalesce(variant_id, ''), state, updated_at DESC);

-- One immutable admission receipt per discovery batch, committed with its queue items.
-- Skipped SKUs have no queue item; replaying a scan returns these counts without admitting again.
CREATE TABLE queue_scan_admission (
  batch_id uuid PRIMARY KEY REFERENCES link_batch(batch_id),
  recent_skip_hours integer NOT NULL CHECK (recent_skip_hours BETWEEN 0 AND 8760),
  added integer NOT NULL CHECK (added >= 0),
  following integer NOT NULL CHECK (following >= 0),
  recent integer NOT NULL CHECK (recent >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER queue_scan_admission_immutable BEFORE UPDATE OR DELETE ON queue_scan_admission
  FOR EACH ROW EXECUTE FUNCTION preserve_link_batch();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT ON queue_scan_admission TO v3_runtime;
  END IF;
END $$;
COMMIT;
