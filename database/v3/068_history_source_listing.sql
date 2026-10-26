BEGIN;

-- Enrichment without a capture operation (backfills, owner 2026-10-26) reads the newest saved capture of the listing
-- (enrichment-source.ts). Without this index the lookup scanned all of product_history_source (1.3 GB, 4.7 s) and
-- hit the 5 s statement timeout, so these products were never enriched. The expression matches the query exactly.
CREATE INDEX product_history_source_listing
  ON product_history_source (((record -> 'listing') ->> 'externalId'))
  WHERE record ->> 'codec' LIKE 'v3-capture-history/%';

COMMIT;
