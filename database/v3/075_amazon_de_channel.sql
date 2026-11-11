BEGIN;
-- KAN-243 (owner 2026-11-11): amazon.de is its own channel, `amazon-de`, the same way amazon.ca became `amazon-ca`
-- (074): an ASIN sold on several storefronts keeps one listing, capture history and listing state per storefront.
-- Every existing row stays as it is. The queue starts paused like every channel: nothing runs on amazon.de until
-- someone resumes it.

ALTER TABLE brand_source DROP CONSTRAINT brand_source_channel_check;
ALTER TABLE brand_source ADD CONSTRAINT brand_source_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'amazon-uk', 'amazon-ca', 'amazon-de', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

ALTER TABLE queue_control DROP CONSTRAINT queue_control_channel_check;
ALTER TABLE queue_control ADD CONSTRAINT queue_control_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'amazon-uk', 'amazon-ca', 'amazon-de', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));
INSERT INTO queue_control (channel) VALUES ('amazon-de');

ALTER TABLE brand_scan DROP CONSTRAINT brand_scan_channel_check;
ALTER TABLE brand_scan ADD CONSTRAINT brand_scan_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'amazon-uk', 'amazon-ca', 'amazon-de', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

ALTER TABLE listing_state_observation DROP CONSTRAINT listing_state_observation_channel_check;
ALTER TABLE listing_state_observation ADD CONSTRAINT listing_state_observation_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'amazon-uk', 'amazon-ca', 'amazon-de', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

ALTER TABLE formula_link DROP CONSTRAINT formula_link_channel_check;
ALTER TABLE formula_link ADD CONSTRAINT formula_link_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'amazon-uk', 'amazon-ca', 'amazon-de', 'gnc', 'swanson', 'dtc', 'costco', 'wholefoods'));

ALTER TABLE product_sync DROP CONSTRAINT product_sync_channel_check;
ALTER TABLE product_sync ADD CONSTRAINT product_sync_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'amazon-uk', 'amazon-ca', 'amazon-de', 'gnc', 'swanson', 'wholefoods', 'costco'));

ALTER TABLE cross_market_check DROP CONSTRAINT cross_market_check_channel_check;
ALTER TABLE cross_market_check ADD CONSTRAINT cross_market_check_channel_check
  CHECK (channel IN ('amazon', 'amazon-in', 'amazon-uk', 'amazon-ca', 'amazon-de'));
COMMIT;
