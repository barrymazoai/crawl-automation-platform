-- Additive receipt protocol admission. Never rewrite immutable processing facts.
BEGIN;
SET LOCAL search_path=public;
ALTER TABLE processing_result DROP CONSTRAINT processing_result_codec;
ALTER TABLE processing_result ADD CONSTRAINT processing_result_codec CHECK(COALESCE(
  record->>'schemaVersion'='1' OR
  (record->>'schemaVersion'='2' AND record->>'codec'='vision-result/2'
    AND record->'input'->>'extractionProtocol' IN ('label-extraction/1','label-extraction/2')), false));
COMMIT;
