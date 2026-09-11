-- Extend codec admission without rewriting any existing immutable snapshot.
BEGIN;
SET LOCAL search_path=public;
DO $$
DECLARE constraint_name text; matches integer;
BEGIN
  SELECT count(*), min(conname::text) INTO matches, constraint_name FROM pg_constraint
    WHERE conrelid='public.collected_product'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%collected-product/1%';
  IF matches <> 1 THEN RAISE EXCEPTION 'Unexpected collected product codec constraint'; END IF;
  EXECUTE format('ALTER TABLE public.collected_product DROP CONSTRAINT %I', constraint_name);
END;
$$;
ALTER TABLE collected_product ADD CONSTRAINT collected_product_codec CHECK(COALESCE(
  (record->>'schemaVersion'='1' AND record->>'codec'='collected-product/1') OR
  (record->>'schemaVersion'='2' AND record->>'codec'='collected-product/2'), false));
COMMENT ON TABLE collected_product IS 'Immutable verified Formula/Ingredients snapshots: image codec /1 or mixed text/image codec /2. Shared observation uniqueness; not formal company synchronization.';
COMMIT;
