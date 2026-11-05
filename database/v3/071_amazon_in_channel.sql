BEGIN;
-- KAN-243 (owner 2026-11-05): amazon.in is its own channel, `amazon-in`, so an ASIN sold on both storefronts keeps two
-- listings, two capture histories and two listing states. Every existing row stays as it is; the US channel is
-- unchanged. The queue starts paused like every channel: nothing runs on amazon.in until someone resumes it.

ALTER TABLE brand_source DROP CONSTRAINT brand_source_channel_check;
ALTER TABLE brand_source ADD CONSTRAINT brand_source_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

ALTER TABLE queue_control DROP CONSTRAINT queue_control_channel_check;
ALTER TABLE queue_control ADD CONSTRAINT queue_control_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));
INSERT INTO queue_control (channel) VALUES ('amazon-in');

ALTER TABLE brand_scan DROP CONSTRAINT brand_scan_channel_check;
ALTER TABLE brand_scan ADD CONSTRAINT brand_scan_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

ALTER TABLE listing_state_observation DROP CONSTRAINT listing_state_observation_channel_check;
ALTER TABLE listing_state_observation ADD CONSTRAINT listing_state_observation_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

ALTER TABLE formula_link DROP CONSTRAINT formula_link_channel_check;
ALTER TABLE formula_link ADD CONSTRAINT formula_link_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

ALTER TABLE product_sync DROP CONSTRAINT product_sync_channel_check;
ALTER TABLE product_sync ADD CONSTRAINT product_sync_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'gnc', 'swanson', 'wholefoods', 'costco'));
COMMIT;
