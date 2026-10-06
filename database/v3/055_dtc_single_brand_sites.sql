-- Site analysis decides whether a domain sells one brand or several, but the apply step saved every source as
-- multi-brand (owner 2026-10-06). A multi-brand policy demands a printed brand on every catalog card, so brand-owned
-- stores failed DTC.BRAND_UNVERIFIED. Sources whose analysis found exactly one brand on their domain become
-- single-brand; a Shopify store saved at the bare /collections index now starts at /collections/all.
BEGIN;
SET LOCAL search_path=public;

CREATE TEMP TABLE single_brand_source ON COMMIT DROP AS
SELECT settings.source_id, settings.settings->>'siteKey' AS site_key, settings.settings->>'platform' AS platform,
  source.url AS catalog_url
FROM dtc_source_settings settings
JOIN brand_source source ON source.id = settings.source_id
JOIN dtc_site_analysis analysis ON analysis.id = settings.analysis_id
WHERE settings.settings->>'kind' = 'multi-brand'
  AND jsonb_array_length(settings.settings->'brands') = 1
  AND (SELECT count(*) FROM jsonb_array_elements(analysis.brands) brand
       WHERE brand->>'domain' = settings.settings->>'siteKey') = 1
  AND (SELECT count(*) FROM dtc_source_settings other
       WHERE other.settings->>'siteKey' = settings.settings->>'siteKey') = 1;

UPDATE single_brand_source SET catalog_url = 'https://' || site_key || '/collections/all'
WHERE platform = 'shopify' AND catalog_url IN ('https://' || site_key || '/collections',
  'https://' || site_key || '/collections/');

UPDATE brand_source source SET url = single.catalog_url
FROM single_brand_source single
WHERE source.id = single.source_id AND source.url <> single.catalog_url;

UPDATE dtc_source_settings settings
SET settings = jsonb_build_object('siteKey', single.site_key, 'platform', single.platform,
  'kind', 'single-brand', 'catalogUrl', single.catalog_url)
FROM single_brand_source single
WHERE settings.source_id = single.source_id;
COMMIT;
