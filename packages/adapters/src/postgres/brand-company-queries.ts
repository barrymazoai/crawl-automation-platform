const MARKETPLACE_CHANNELS = `('amazon', 'gnc', 'swanson', 'wholefoods', 'costco')`;

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

/**
 * Owner 2026-10-15: brands still waiting for a company, most completed products first. Without $2 a brand gets one
 * marketplace run; named brands ($2) are only held back by a live run.
 */
export const waitingMarketplaceBrands = `
  WITH latest AS (
    SELECT DISTINCT ON (q.channel, q.listing_id, q.variant_id) q.channel, q.source_id, q.state
    FROM queue_item q
    WHERE q.channel IN ${MARKETPLACE_CHANNELS}
    ORDER BY q.channel, q.listing_id, q.variant_id, q.created_at DESC, q.item_id DESC
  ), counts AS (
    SELECT source.brand_id, count(*)::int AS products
    FROM latest JOIN brand_source source ON source.id = latest.source_id AND source.channel = latest.channel
    WHERE latest.state = 'completed'
    GROUP BY source.brand_id
  )
  SELECT brand.id AS "brandId", brand.name, counts.products
  FROM counts JOIN brand ON brand.id = counts.brand_id
  JOIN supply_smart_brand_company match ON match.brand_id = brand.id AND match.status <> 'matched'
  WHERE CASE WHEN $2::uuid[] IS NULL
    THEN NOT EXISTS (SELECT 1 FROM brand_enrichment_run run WHERE run.brand_id = brand.id)
    ELSE brand.id = ANY($2::uuid[]) AND NOT EXISTS (SELECT 1 FROM brand_enrichment_run run
      WHERE run.brand_id = brand.id AND run.state IN ('running', 'waiting_for_person')) END
  ORDER BY counts.products DESC, brand.id
  LIMIT $1`;

/** A few completed product pages of one brand, spread over its channels. */
export const marketplaceBrandListings = `
  SELECT channel, url FROM (
    SELECT channel, url, row_number() OVER (PARTITION BY channel ORDER BY url) AS rank
    FROM (
      SELECT DISTINCT q.channel, q.url
      FROM queue_item q JOIN brand_source source ON source.id = q.source_id AND source.channel = q.channel
      WHERE source.brand_id = $1 AND q.state = 'completed' AND q.channel IN ${MARKETPLACE_CHANNELS}
    ) pages
  ) ranked
  ORDER BY rank, channel, url
  LIMIT $2`;

/** Marketplace runs still alive; the automatic sweep keeps their number bounded (owner 2026-10-16). */
export const liveMarketplaceRuns = `
  SELECT count(*)::int AS live FROM brand_enrichment_run
  WHERE role = 'marketplace' AND state NOT IN ('completed', 'failed', 'cancelled')`;
