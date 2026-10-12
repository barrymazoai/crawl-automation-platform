/** Choose latest state before filtering completion, across every source for the listing identity. */
export const completedMarketplaceBrands = `
  WITH latest AS (
    SELECT DISTINCT ON (q.channel, q.listing_id, q.variant_id)
      q.channel, q.listing_id, q.variant_id, q.source_id, q.state
    FROM queue_item q
    WHERE q.channel IN ('amazon', 'gnc', 'swanson', 'wholefoods', 'costco')
    ORDER BY q.channel, q.listing_id, q.variant_id, q.created_at DESC, q.item_id DESC
  ), counts AS (
    SELECT source.brand_id, jsonb_build_object(
      'amazon', count(*) FILTER (WHERE latest.channel = 'amazon'),
      'gnc', count(*) FILTER (WHERE latest.channel = 'gnc'),
      'swanson', count(*) FILTER (WHERE latest.channel = 'swanson'),
      'wholefoods', count(*) FILTER (WHERE latest.channel = 'wholefoods'),
      'costco', count(*) FILTER (WHERE latest.channel = 'costco')
    ) AS product_counts
    FROM latest JOIN brand_source source ON source.id = latest.source_id AND source.channel = latest.channel
    WHERE latest.state = 'completed'
    GROUP BY source.brand_id
  )
  SELECT brand.id AS "brandId", brand.name, counts.product_counts AS "productCounts",
    ARRAY(SELECT DISTINCT source.url FROM brand_source source
      WHERE source.brand_id = brand.id AND source.channel = 'dtc' ORDER BY source.url) AS "dtcUrls",
    match.status, match.company_id AS "companyId", match.domain, match.matched_by AS "matchedBy",
    match.candidates, match.checked_at AS "checkedAt"
  FROM counts JOIN brand ON brand.id = counts.brand_id
  LEFT JOIN supply_smart_brand_company match ON match.brand_id = brand.id`;

export const upsertBrandCompany = `
  INSERT INTO supply_smart_brand_company
    (brand_id, status, company_id, domain, matched_by, candidates, checked_at)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
  ON CONFLICT (brand_id) DO UPDATE SET
    status = EXCLUDED.status, company_id = EXCLUDED.company_id, domain = EXCLUDED.domain,
    matched_by = EXCLUDED.matched_by, candidates = EXCLUDED.candidates, checked_at = EXCLUDED.checked_at`;
