-- collected-product/5 (owner 2026-10-06): a label product has a formula, ingredients or both, and records its
-- printed panel type and page evidence. Old immutable snapshots are not rewritten; /1-/4 keep their checks.
BEGIN;
SET LOCAL search_path=public;
ALTER TABLE collected_product DROP CONSTRAINT collected_product_codec;
ALTER TABLE collected_product ADD CONSTRAINT collected_product_codec CHECK(COALESCE(
  (record->>'schemaVersion'='1' AND record->>'codec'='collected-product/1') OR
  (record->>'schemaVersion'='2' AND record->>'codec'='collected-product/2') OR
  (record->>'schemaVersion'='3' AND record->>'codec'='collected-product/3') OR
  (record->>'schemaVersion'='4' AND record->>'codec'='collected-product/4'
    AND record->>'admissionPolicy'='label-packaging/1'
    AND record->'packaging'->>'codec'='packaging-facts/1') OR
  (record->>'schemaVersion'='5' AND record->>'codec'='collected-product/5'
    AND record->>'evidencePolicy'='label-image-first/7'
    AND record->>'labelType' IN ('supplement_facts','nutrition_facts','drug_facts','unknown','none')
    AND (record->'packaging' IS NULL OR (record->>'admissionPolicy'='label-packaging/1'
      AND record->'packaging'->>'codec'='packaging-facts/1'))), false));
ALTER TABLE collected_product DROP CONSTRAINT collected_product_record_check2;
ALTER TABLE collected_product ADD CONSTRAINT collected_product_record_check2 CHECK(COALESCE(
  jsonb_typeof(record->'formula')='object' OR
  (record->>'schemaVersion'='5' AND jsonb_typeof(record->'formula')='null'), false));
ALTER TABLE collected_product DROP CONSTRAINT collected_product_record_check3;
ALTER TABLE collected_product ADD CONSTRAINT collected_product_record_check3 CHECK(COALESCE(
  jsonb_typeof(record->'ingredients')='array' AND
  (jsonb_array_length(record->'ingredients')>0 OR record->>'schemaVersion'='5'), false));
ALTER TABLE collected_product ADD CONSTRAINT collected_product_one_part CHECK(
  record->>'schemaVersion' IS DISTINCT FROM '5' OR COALESCE(
    (record->>'formulaFound')::boolean OR (record->>'ingredientsFound')::boolean, false));
COMMENT ON TABLE collected_product IS 'Immutable Formula/Ingredients snapshots, codecs /1 image, /2 mixed, /3 grouped label, /4 packaging-aware label, /5 formula and/or ingredients with label type and page evidence. No company matching prerequisite; not formal product synchronization.';
COMMIT;
