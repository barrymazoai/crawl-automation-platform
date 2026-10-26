import type { Queryable } from "@crawl-automation/platform";
import {
  EnrichmentRequestSchema,
  SHARED_ENRICHMENT_PROTOCOL,
  type EnrichmentRequest,
} from "@crawl-automation/v3-contracts";

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

/**
 * Sent marketplace products (the sync ledger) whose collection has no enrichment of the current protocol for the
 * channel delivery reads: Whole Foods carries its Amazon ASIN's collection and reads the Amazon subject. Never
 * enriched first, then /2 (no main ingredients), then the rest. Set-based, and each collection record is read once:
 * a per-row lookup into the large records took 7 s on 50k sent products (2026-10-26).
 */
export const OUTDATED_ENRICHMENT = `
  WITH sent AS (
    SELECT DISTINCT ps.collected_operation_id AS operation_id,
           CASE ps.channel WHEN 'wholefoods' THEN 'amazon' ELSE ps.channel END AS channel
      FROM product_sync ps
     WHERE ps.collected_operation_id IS NOT NULL AND ps.status IN ('verified', 'sent')),
  targets AS MATERIALIZED (
    SELECT t.operation_id, t.channel, o."listingId" AS listing_id, o."variantId" AS variant_id
      FROM sent t JOIN collected_product p ON p.operation_id = t.operation_id
      CROSS JOIN LATERAL jsonb_to_record(p.record->'observation') AS o("listingId" text, "variantId" text)),
  latest AS (
    SELECT DISTINCT ON (s.collection_operation_id, s.channel, s.listing_id, s.variant_id)
           s.collection_operation_id, s.channel, s.listing_id, s.variant_id, e.protocol AS codec
      FROM product_enrichment_subject s JOIN product_enrichment e USING (enrichment_id)
     ORDER BY s.collection_operation_id, s.channel, s.listing_id, s.variant_id,
              s.registered_at DESC, s.subject_id DESC)
  SELECT t.*, latest.codec FROM targets t
  LEFT JOIN latest ON latest.collection_operation_id = t.operation_id AND latest.channel = t.channel
   AND latest.listing_id = t.listing_id AND latest.variant_id IS NOT DISTINCT FROM t.variant_id
  WHERE latest.codec IS DISTINCT FROM $2
  ORDER BY CASE WHEN latest.codec IS NULL THEN 0 WHEN latest.codec = 'product-enrichment/2' THEN 1 ELSE 2 END,
    t.channel, t.listing_id, t.variant_id NULLS FIRST, t.operation_id
  LIMIT $1`;

export async function outdatedEnrichment(
  database: Queryable,
  limit: number,
): Promise<EnrichmentRequest[]> {
  const rows = await database.query<{
    operation_id: string;
    channel: string;
    listing_id: string;
    variant_id: string | null;
  }>(OUTDATED_ENRICHMENT, [limit, SHARED_ENRICHMENT_PROTOCOL]);
  return rows.map((row) =>
    EnrichmentRequestSchema.parse({
      collectionOperationId: row.operation_id,
      channel: row.channel,
      listingId: row.listing_id,
      variantId: row.variant_id,
    }),
  );
}
