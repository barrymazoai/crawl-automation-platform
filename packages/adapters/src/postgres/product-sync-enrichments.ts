import type { RefreshedEnrichment, RefreshedEnrichmentFilter } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { SHARED_ENRICHMENT_PROTOCOL } from "@crawl-automation/v3-contracts";

/**
 * Products in Supply Smart (ledger rows with its product ID: verified, sent, or failed after an earlier send, such as
 * the idempotency conflicts of a resend) whose every enriched listing's latest enrichment is of the current protocol.
 * As in delivery, a listing's enrichment is the latest subject of its collection (Whole Foods reads its Amazon
 * ASIN's); the ledger's listing ID is not the subject's (Swanson ledgers the page slug). Earlier names come from
 * older-protocol subjects of that subject's listing. Products are picked on the protocol columns alone; candidates
 * are read only for the page.
 */
const REFRESHED_ENRICHMENTS = `
  WITH ours AS (
    SELECT ps.supply_smart_product_id AS product_id, ps.status, ps.updated_at, ps.collected_operation_id,
           CASE ps.channel WHEN 'wholefoods' THEN 'amazon' ELSE ps.channel END AS channel
      FROM product_sync ps
     WHERE ps.supply_smart_product_id IS NOT NULL AND ps.status IN ('verified', 'sent', 'failed')
       AND ps.collected_operation_id IS NOT NULL
       AND ($1::uuid IS NULL OR ps.supply_smart_product_id > $1::uuid)
       AND ($4::uuid[] IS NULL OR ps.supply_smart_product_id = ANY($4::uuid[]))),
  latest AS MATERIALIZED (
    SELECT o.product_id, o.status, o.updated_at, l.channel, l.listing_id, l.variant_id, l.enrichment_id,
           l.protocol, l.registered_at
      FROM ours o LEFT JOIN LATERAL (
        SELECT s.channel, s.listing_id, s.variant_id, s.enrichment_id, e.protocol, s.registered_at
          FROM product_enrichment_subject s JOIN product_enrichment e USING (enrichment_id)
         WHERE s.collection_operation_id = o.collected_operation_id AND s.channel = o.channel
         ORDER BY s.registered_at DESC, s.subject_id DESC LIMIT 1) l ON true),
  ready AS (
    SELECT product_id,
           bool_or(NOT (status = 'verified' AND registered_at < updated_at)) AS sent_before_current
      FROM latest GROUP BY product_id
    HAVING bool_and(protocol = $3)
     ORDER BY product_id LIMIT $2),
  names AS (
    SELECT l.product_id, true AS current, l.registered_at, e.record->'candidate' AS c
      FROM latest l JOIN ready USING (product_id) JOIN product_enrichment e USING (enrichment_id)
    UNION ALL
    SELECT l.product_id, false, s.registered_at, e.record->'candidate'
      FROM latest l JOIN ready USING (product_id)
      JOIN product_enrichment_subject s ON s.channel = l.channel AND s.listing_id = l.listing_id
       AND s.variant_id IS NOT DISTINCT FROM l.variant_id
      JOIN product_enrichment e ON e.enrichment_id = s.enrichment_id
     WHERE e.protocol <> $3),
  sent AS (
    SELECT product_id, current, registered_at,
           CASE WHEN c->>'form' IN ('unknown', 'other') THEN NULL ELSE c->>'form' END AS form,
           CASE WHEN current AND jsonb_array_length(coalesce(c->'healthFunctions', '[]')) = 0
                THEN coalesce(c->'inferredHealthFunctions', '[]') ELSE coalesce(c->'healthFunctions', '[]')
           END AS health_functions,
           coalesce(c->'functionalIngredients', '[]') AS main_ingredients
      FROM names)
  SELECT r.product_id::text, r.sent_before_current,
    coalesce((SELECT array_agg(form ORDER BY registered_at DESC) FROM sent
       WHERE product_id = r.product_id AND current AND form IS NOT NULL), '{}') AS current_forms,
    coalesce((SELECT array_agg(DISTINCT n) FROM sent, jsonb_array_elements_text(health_functions) n
       WHERE product_id = r.product_id AND current), '{}') AS current_health_functions,
    coalesce((SELECT array_agg(DISTINCT n) FROM sent, jsonb_array_elements_text(main_ingredients) n
       WHERE product_id = r.product_id AND current), '{}') AS current_main_ingredients,
    coalesce((SELECT array_agg(DISTINCT form) FROM sent
       WHERE product_id = r.product_id AND NOT current AND form IS NOT NULL), '{}') AS previous_forms,
    coalesce((SELECT array_agg(DISTINCT n) FROM sent, jsonb_array_elements_text(health_functions) n
       WHERE product_id = r.product_id AND NOT current), '{}') AS previous_health_functions,
    coalesce((SELECT array_agg(DISTINCT n) FROM sent, jsonb_array_elements_text(main_ingredients) n
       WHERE product_id = r.product_id AND NOT current), '{}') AS previous_main_ingredients
  FROM ready r ORDER BY r.product_id`;

interface Row {
  product_id: string;
  sent_before_current: boolean;
  current_forms: string[];
  current_health_functions: string[];
  current_main_ingredients: string[];
  previous_forms: string[];
  previous_health_functions: string[];
  previous_main_ingredients: string[];
}

export async function refreshedEnrichments(
  database: Queryable,
  filter: RefreshedEnrichmentFilter,
): Promise<RefreshedEnrichment[]> {
  const rows = await database.query<Row>(REFRESHED_ENRICHMENTS, [
    filter.after ?? null,
    filter.limit,
    SHARED_ENRICHMENT_PROTOCOL,
    filter.productIds ?? null,
  ]);
  return rows.map((row) => ({
    supplySmartProductId: row.product_id,
    current: {
      forms: [...new Set(row.current_forms)],
      healthFunctions: row.current_health_functions,
      mainIngredients: row.current_main_ingredients,
    },
    previous: {
      forms: row.previous_forms,
      healthFunctions: row.previous_health_functions,
      mainIngredients: row.previous_main_ingredients,
    },
    sentBeforeCurrent: row.sent_before_current,
  }));
}
