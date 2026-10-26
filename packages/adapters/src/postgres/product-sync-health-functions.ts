import type { RefreshedHealthFunctions } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { SHARED_ENRICHMENT_PROTOCOL } from "@crawl-automation/v3-contracts";

/**
 * Products whose every sent listing is verified after its latest enrichment, which is of the current protocol. As in
 * delivery, a listing's enrichment is the latest subject of its collection (Whole Foods reads its Amazon ASIN's);
 * the ledger's listing ID is not the subject's (Swanson ledgers the page slug). Earlier names are the printed ones
 * of that subject's listing under older protocols; current names are what delivery sends (printed, or else
 * inferred). Products are picked on the protocol columns alone; candidates are read only for the page.
 */
const REFRESHED_HEALTH_FUNCTIONS = `
  WITH ours AS (
    SELECT ps.supply_smart_product_id AS product_id, ps.status, ps.updated_at, ps.collected_operation_id,
           CASE ps.channel WHEN 'wholefoods' THEN 'amazon' ELSE ps.channel END AS channel
      FROM product_sync ps
     WHERE ps.supply_smart_product_id IS NOT NULL AND ps.status IN ('verified', 'sent')
       AND ($1::uuid IS NULL OR ps.supply_smart_product_id > $1::uuid)),
  latest AS MATERIALIZED (
    SELECT o.product_id, o.status, o.updated_at, l.channel, l.listing_id, l.variant_id, l.enrichment_id,
           l.protocol, l.registered_at
      FROM ours o LEFT JOIN LATERAL (
        SELECT s.channel, s.listing_id, s.variant_id, s.enrichment_id, e.protocol, s.registered_at
          FROM product_enrichment_subject s JOIN product_enrichment e USING (enrichment_id)
         WHERE s.collection_operation_id = o.collected_operation_id AND s.channel = o.channel
         ORDER BY s.registered_at DESC, s.subject_id DESC LIMIT 1) l ON true),
  ready AS (
    SELECT product_id FROM latest GROUP BY product_id
    HAVING bool_and(status = 'verified' AND protocol = $3 AND registered_at < updated_at)
     ORDER BY product_id LIMIT $2),
  names AS (
    SELECT l.product_id, true AS current, e.record->'candidate' AS c
      FROM latest l JOIN ready USING (product_id) JOIN product_enrichment e USING (enrichment_id)
    UNION ALL
    SELECT l.product_id, false, e.record->'candidate'
      FROM latest l JOIN ready USING (product_id)
      JOIN product_enrichment_subject s ON s.channel = l.channel AND s.listing_id = l.listing_id
       AND s.variant_id IS NOT DISTINCT FROM l.variant_id
      JOIN product_enrichment e ON e.enrichment_id = s.enrichment_id
     WHERE e.protocol <> $3)
  SELECT r.product_id::text,
    coalesce((SELECT array_agg(DISTINCT n) FROM names l,
       jsonb_array_elements_text(CASE WHEN jsonb_array_length(coalesce(l.c->'healthFunctions', '[]')) > 0
         THEN l.c->'healthFunctions' ELSE coalesce(l.c->'inferredHealthFunctions', '[]') END) n
      WHERE l.product_id = r.product_id AND l.current), '{}') AS current,
    coalesce((SELECT array_agg(DISTINCT n) FROM names x,
       jsonb_array_elements_text(coalesce(x.c->'healthFunctions', '[]')) n
      WHERE x.product_id = r.product_id AND NOT x.current), '{}') AS previous
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
