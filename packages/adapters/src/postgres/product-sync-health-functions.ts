import type { RefreshedHealthFunctions } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { SHARED_ENRICHMENT_PROTOCOL } from "@crawl-automation/v3-contracts";

/**
 * Products whose every sent listing is verified after its latest enrichment, which is of the current protocol
 * (Whole Foods reads its Amazon ASIN's). Products are picked on the protocol columns alone; candidates are read only
 * for the page. Current names are what delivery sends (printed, or else inferred); earlier names are the printed
 * ones of older enrichments of the same listings.
 */
const REFRESHED_HEALTH_FUNCTIONS = `
  WITH ours AS (
    SELECT ps.supply_smart_product_id AS product_id, ps.status, ps.updated_at,
           CASE ps.channel WHEN 'wholefoods' THEN 'amazon' ELSE ps.channel END AS channel,
           ps.listing_id, ps.variant_key
      FROM product_sync ps
     WHERE ps.supply_smart_product_id IS NOT NULL AND ps.status IN ('verified', 'sent')
       AND ($1::uuid IS NULL OR ps.supply_smart_product_id > $1::uuid)),
  enriched AS MATERIALIZED (
    SELECT o.product_id, o.channel, o.listing_id, o.variant_key, s.enrichment_id, e.protocol, s.registered_at,
           row_number() OVER (PARTITION BY o.product_id, o.channel, o.listing_id, o.variant_key
                              ORDER BY s.registered_at DESC, s.subject_id DESC) AS rn
      FROM ours o
      JOIN product_enrichment_subject s ON s.channel = o.channel AND s.listing_id = o.listing_id
       AND coalesce(s.variant_id, '') = o.variant_key
      JOIN product_enrichment e USING (enrichment_id)),
  ready AS (
    SELECT o.product_id FROM ours o
      LEFT JOIN enriched l ON l.rn = 1 AND l.product_id = o.product_id AND l.channel = o.channel
       AND l.listing_id = o.listing_id AND l.variant_key = o.variant_key
     GROUP BY o.product_id
    HAVING bool_and(o.status = 'verified' AND l.protocol = $3 AND l.registered_at < o.updated_at)
     ORDER BY o.product_id LIMIT $2),
  names AS (
    SELECT x.product_id, x.protocol, x.rn, e.record->'candidate' AS c
      FROM enriched x JOIN ready r USING (product_id) JOIN product_enrichment e USING (enrichment_id)
     WHERE x.rn = 1 OR x.protocol <> $3)
  SELECT r.product_id::text,
    coalesce((SELECT array_agg(DISTINCT n) FROM names l,
       jsonb_array_elements_text(CASE WHEN jsonb_array_length(coalesce(l.c->'healthFunctions', '[]')) > 0
         THEN l.c->'healthFunctions' ELSE coalesce(l.c->'inferredHealthFunctions', '[]') END) n
      WHERE l.product_id = r.product_id AND l.rn = 1), '{}') AS current,
    coalesce((SELECT array_agg(DISTINCT n) FROM names x,
       jsonb_array_elements_text(coalesce(x.c->'healthFunctions', '[]')) n
      WHERE x.product_id = r.product_id AND x.protocol <> $3), '{}') AS previous
  FROM ready r ORDER BY r.product_id`;

export async function refreshedHealthFunctions(
  database: Queryable,
  filter: { after?: string; limit: number },
): Promise<RefreshedHealthFunctions[]> {
  const rows = await database.query<{ product_id: string; current: string[]; previous: string[] }>(
    REFRESHED_HEALTH_FUNCTIONS,
    [filter.after ?? null, filter.limit, SHARED_ENRICHMENT_PROTOCOL],
  );
  return rows.map((row) => ({
    supplySmartProductId: row.product_id,
    current: row.current,
    previous: row.previous,
  }));
}
