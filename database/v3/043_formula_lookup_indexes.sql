BEGIN;

-- Formula reuse looks products up by JSON fields (postgres-formula-index.ts). Without these indexes each family
-- member's lookup scanned all of product_history_source (1 GB) and hit the statement timeout (2026-10-01).
-- The expressions match the queries exactly so the planner can use them.

-- Saved captures of a page: CAPTURE_IDENTITY (codec + URL without the query string).
CREATE INDEX product_history_source_capture_url
  ON product_history_source (split_part((record -> 'listing') ->> 'url', '?', 1))
  WHERE record ->> 'codec' = 'v3-capture-history/1';

-- Collected products by listing (FIND_KNOWN, FIND_MEMBER) and by the run that collected them (CAPTURE_OWNER).
CREATE INDEX collected_product_listing
  ON collected_product (((record -> 'observation') ->> 'listingId'));
CREATE INDEX collected_product_request
  ON collected_product (((record -> 'observation') ->> 'requestId'));

COMMIT;
