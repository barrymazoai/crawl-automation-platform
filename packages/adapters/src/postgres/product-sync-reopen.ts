import type { ReopenFilter, ReopenResult } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { SHARED_ENRICHMENT_PROTOCOL } from "@crawl-automation/v3-contracts";

/** Picked rows become pending again: their material time moves before every capture. Nothing is deleted. */
const REOPEN_SYNC = `WITH picked AS (
         SELECT channel, listing_id, variant_key FROM product_sync
         WHERE ($1::text IS NULL OR channel = $1) AND (
           (status = 'failed' AND error->>'reason' = $2)
           -- Sent without a formula: the ledger keeps the formula's operation for every product that carried one.
           OR ($4::boolean AND status = 'verified' AND collected_operation_id IS NULL)
           -- Outcome never recorded; old enough that no batch is still sending it.
           OR ($5::boolean AND status = 'sent' AND updated_at < now() - interval '10 minutes')
           OR ($6::boolean AND status = 'present')
           OR ($7::boolean AND status = 'verified' AND collected_operation_id IS NOT NULL)
           -- Enriched again (current protocol) after the send; Whole Foods reads its Amazon ASIN's subject.
           OR ($8::boolean AND status = 'verified' AND EXISTS (
             SELECT 1 FROM product_enrichment_subject s JOIN product_enrichment e USING (enrichment_id)
              WHERE s.collection_operation_id = product_sync.collected_operation_id
                AND s.channel = CASE product_sync.channel WHEN 'wholefoods' THEN 'amazon' ELSE product_sync.channel END
                AND e.protocol = $9 AND s.registered_at > product_sync.updated_at)))
         ORDER BY updated_at LIMIT $3),
       moved AS (
         UPDATE product_sync ps SET material_at = '-infinity', updated_at = clock_timestamp()
         FROM picked WHERE ps.channel = picked.channel AND ps.listing_id = picked.listing_id
           AND ps.variant_key = picked.variant_key
         RETURNING 1)
       SELECT count(*)::int AS reopened FROM moved`;

export async function reopenSync(
  database: Queryable,
  filter: Exclude<ReopenFilter, { listingDates: true }>,
): Promise<ReopenResult> {
  const rows = await database.query<{ reopened: number }>(REOPEN_SYNC, [
    filter.channel ?? null,
    "reason" in filter ? filter.reason : null,
    filter.limit,
    "withoutLabel" in filter,
    "unfinished" in filter,
    "present" in filter,
    "withLabel" in filter,
    "enriched" in filter,
    SHARED_ENRICHMENT_PROTOCOL,
  ]);
  return { reopened: rows[0]?.reopened ?? 0 };
}
