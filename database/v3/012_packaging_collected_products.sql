-- Opt-in packaging policy. Old immutable snapshots and Reviews are not rewritten.
BEGIN;
SET LOCAL search_path=public;
ALTER TABLE collected_product DROP CONSTRAINT collected_product_codec;
ALTER TABLE collected_product ADD CONSTRAINT collected_product_codec CHECK(COALESCE(
  (record->>'schemaVersion'='1' AND record->>'codec'='collected-product/1') OR
  (record->>'schemaVersion'='2' AND record->>'codec'='collected-product/2') OR
  (record->>'schemaVersion'='3' AND record->>'codec'='collected-product/3') OR
  (record->>'schemaVersion'='4' AND record->>'codec'='collected-product/4'
    AND record->>'admissionPolicy'='label-packaging/1'
    AND record->'packaging'->>'codec'='packaging-facts/1'), false));
COMMENT ON TABLE collected_product IS 'Immutable Formula/Ingredients snapshots, codecs /1 image, /2 mixed, /3 grouped label, /4 packaging-aware label. No company matching prerequisite; not formal product synchronization.';
COMMIT;
