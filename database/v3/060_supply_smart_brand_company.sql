-- Marketplace sync (owner 2026-10-12): resolve existing companies only; never create one here.
BEGIN;
SET LOCAL search_path = public;

CREATE TABLE supply_smart_brand_company (
  brand_id uuid PRIMARY KEY REFERENCES brand(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('matched', 'unmatched', 'ambiguous')),
  -- Supply Smart IDs are external; there is no local company foreign key.
  company_id uuid,
  domain text,
  matched_by text,
  candidates jsonb NOT NULL DEFAULT '[]',
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT supply_smart_brand_company_match CHECK (
    (status = 'matched' AND company_id IS NOT NULL AND domain IS NOT NULL AND btrim(domain) <> '')
    OR (status <> 'matched' AND company_id IS NULL AND domain IS NULL)
  ),
  CONSTRAINT supply_smart_brand_company_candidates CHECK (
    CASE WHEN jsonb_typeof(candidates) = 'array' THEN jsonb_array_length(candidates) <= 20
      ELSE false END
    AND NOT jsonb_path_exists(candidates,
      '$[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"))')
    AND (status = 'ambiguous' OR candidates = '[]'::jsonb)
  )
);
CREATE INDEX supply_smart_brand_company_status
  ON supply_smart_brand_company (status, checked_at, brand_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON supply_smart_brand_company TO v3_runtime;
  END IF;
END $$;
COMMIT;
