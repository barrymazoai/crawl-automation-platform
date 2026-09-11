-- New grouped-label codec; no conversion or rewriting of previous snapshots.
BEGIN;
SET LOCAL search_path=public;
ALTER TABLE collected_product DROP CONSTRAINT collected_product_codec;
ALTER TABLE collected_product ADD CONSTRAINT collected_product_codec CHECK(COALESCE(
  (record->>'schemaVersion'='1' AND record->>'codec'='collected-product/1') OR
  (record->>'schemaVersion'='2' AND record->>'codec'='collected-product/2') OR
  (record->>'schemaVersion'='3' AND record->>'codec'='collected-product/3'), false));
COMMENT ON TABLE collected_product IS 'Immutable Formula/Ingredients snapshots, codecs /1 image, /2 mixed, /3 grouped label. No company matching prerequisite; not formal product synchronization.';
COMMIT;
