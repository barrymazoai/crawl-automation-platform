import type { Queryable } from "@crawl-automation/platform";
import { EnrichmentRequestSchema, type EnrichmentRequest } from "@crawl-automation/v3-contracts";

/** Own collections and verified formula links, regardless of their collection age. */
export const MISSING_ENRICHMENT = `
  WITH products AS (
    SELECT p.operation_id, s.channel, p.record->'observation'->>'listingId' AS listing_id,
           p.record->'observation'->>'variantId' AS variant_id
      FROM collected_product p
      JOIN brand_source s ON s.id::text = p.record->'observation'->>'sourceId'
     WHERE p.record->>'codec' IN ('collected-product/3', 'collected-product/4', 'collected-product/5')
    UNION
    SELECT formula_operation_id, channel, listing_id, variant_id FROM formula_link
  )
  SELECT * FROM products p WHERE NOT EXISTS (
    SELECT 1 FROM product_enrichment_subject s
     WHERE s.channel = p.channel AND s.listing_id = p.listing_id
       AND s.variant_id IS NOT DISTINCT FROM p.variant_id
       AND s.collection_operation_id = p.operation_id
  ) ORDER BY channel, listing_id, variant_id NULLS FIRST, operation_id LIMIT $1`;

export async function missingEnrichment(
  database: Queryable,
  limit: number,
): Promise<EnrichmentRequest[]> {
  const family = await database.query<{ available: boolean }>(
    "SELECT to_regclass('public.family_formula_outcome') IS NOT NULL AS available",
  );
  const sql = family[0]?.available
    ? MISSING_ENRICHMENT.replace(
        "SELECT formula_operation_id, channel, listing_id, variant_id FROM formula_link",
        `SELECT formula_operation_id, channel, listing_id, variant_id FROM formula_link
     UNION SELECT formula_operation_id, channel, listing_id, variant_id
       FROM family_formula_outcome WHERE status = 'formula-linked'`,
      )
    : MISSING_ENRICHMENT;
  const rows = await database.query<{
    operation_id: string;
    channel: string;
    listing_id: string;
    variant_id: string | null;
  }>(sql, [limit]);
  return rows.map((row) =>
    EnrichmentRequestSchema.parse({
      collectionOperationId: row.operation_id,
      channel: row.channel,
      listingId: row.listing_id,
      variantId: row.variant_id,
    }),
  );
}
