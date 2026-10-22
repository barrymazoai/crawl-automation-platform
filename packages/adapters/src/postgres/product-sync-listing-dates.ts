import type { ReopenFilter, ReopenResult } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { settledMarketplace } from "../product-sync/marketplace-queries.js";

type ListingDatesFilter = Extract<ReopenFilter, { listingDates: true }>;

/** The existing sweep reparses and sends; this control only reopens previously successful Amazon syncs. */
export async function reopenAmazonListingDates(
  database: Queryable,
  filter: ListingDatesFilter,
): Promise<ReopenResult> {
  const candidates = `WITH ${settledMarketplace("q.channel = 'amazon'")}, candidates AS (
    SELECT ps.channel, ps.listing_id, ps.variant_key, d.run_id::text AS run_id,
      d.material_source_id::text AS source_id, d.material_url AS url FROM product_sync ps
    JOIN done d ON d.channel=ps.channel AND d.listing_id=ps.listing_id
      AND coalesce(d.variant_id,'')=ps.variant_key
    WHERE ps.status IN ('verified','present') AND ps.updated_at < $1::timestamptz
      AND ps.error IS NULL AND ps.material_at >= d.material_at
      AND ps.material_at IS DISTINCT FROM '-infinity'::timestamptz
      AND ($2::text[] IS NULL OR ps.listing_id=ANY($2))
      AND EXISTS (SELECT 1 FROM supply_smart_brand_company m
        WHERE m.brand_id=d.brand_id AND m.status='matched')),
    picked AS (SELECT * FROM candidates ORDER BY listing_id, variant_key LIMIT $3)`;
  const query = filter.dryRun
    ? `${candidates} SELECT 0::int AS reopened, (SELECT count(*)::int FROM candidates) AS eligible,
        ${selection("picked")} AS selected`
    : `${candidates}, moved AS (
        UPDATE product_sync ps SET material_at='-infinity', updated_at=clock_timestamp()
        FROM picked WHERE ps.channel=picked.channel AND ps.listing_id=picked.listing_id
          AND ps.variant_key=picked.variant_key AND ps.status IN ('verified','present')
          AND ps.updated_at < $1::timestamptz
          AND ps.material_at IS DISTINCT FROM '-infinity'::timestamptz
        RETURNING picked.*) SELECT count(*)::int AS reopened,
        (SELECT count(*)::int FROM candidates) AS eligible, ${selection("moved")} AS selected FROM moved`;
  const rows = await database.query<ReopenResult>(query, [
    filter.before,
    filter.listingIds ?? null,
    filter.limit,
  ]);
  return rows[0] ?? { reopened: 0, eligible: 0, selected: [] };
}

function selection(from: "picked" | "moved") {
  return `coalesce((SELECT jsonb_agg(jsonb_build_object('listingId', listing_id,
    'variantId', nullif(variant_key,''), 'runId', run_id, 'sourceId', source_id, 'url', url)
    ORDER BY listing_id, variant_key) FROM ${from}), '[]')`;
}
