-- The Windows OCR service has 4 engines; with 6 OCR permits, bursts got error answers (OCR.HTTP_STATUS, ~10% of
-- calls on 2026-10-06 after a large requeue). Applied by hand the same day; recorded here for every database.
BEGIN;
SET LOCAL search_path=public;
UPDATE resource_capacity SET capacity = 4 WHERE resource_id = 'windows-ocr';
COMMIT;
