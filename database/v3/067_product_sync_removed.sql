-- removed: the crawler deleted the listing's Supply Smart product, which the store files outside supplements
-- (PRODUCT.NOT_SUPPLEMENT, owner 2026-10-26). supply_smart_product_id keeps the deleted product's ID on record; a
-- later capture judged a supplement is sent again and overwrites the row.
BEGIN;
SET LOCAL search_path = public;
ALTER TABLE product_sync DROP CONSTRAINT product_sync_status_check;
ALTER TABLE product_sync ADD CONSTRAINT product_sync_status_check
  CHECK (status IN ('present', 'waiting_company', 'sent', 'verified', 'failed', 'removed'));
COMMIT;
