BEGIN;
-- Amazon Brand-filter search and /s?srs= brand-page scans use the shared brand-scan flow.
-- Store pages remain a separate browser reader. Existing scan identities and results stay immutable.
ALTER TABLE brand_scan DROP CONSTRAINT brand_scan_channel_check;
ALTER TABLE brand_scan ADD CONSTRAINT brand_scan_channel_check
  CHECK (channel IN ('amazon', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));
COMMIT;
