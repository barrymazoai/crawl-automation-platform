import type {
  MarketplaceChannel,
  NotSupplementDelivered,
  NotSupplementFilter,
  SyncKey,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

interface Row {
  channel: MarketplaceChannel;
  listing_id: string;
  variant_key: string;
  supply_smart_product_id: string;
  supply_smart_listing_id: string | null;
  product_removed: boolean;
}

/**
 * Delivered listings whose latest queue item is PRODUCT.NOT_SUPPLEMENT, as in the sync selection: a later capture
 * judged a supplement is not a candidate. Keyset paging; rows whose product is kept stay candidates.
 */
const NOT_SUPPLEMENTS_DELIVERED = `
  WITH latest AS (
    SELECT DISTINCT ON (q.channel, q.listing_id, q.variant_id) q.channel, q.listing_id, q.variant_id, q.reason
    FROM queue_item q WHERE q.channel IN ('amazon', 'gnc', 'swanson', 'wholefoods', 'costco')
      AND ($1::text IS NULL OR q.channel = $1)
    ORDER BY q.channel, q.listing_id, q.variant_id, q.created_at DESC, q.item_id DESC)
  SELECT ps.channel, ps.listing_id, ps.variant_key, ps.supply_smart_product_id::text,
    ps.supply_smart_listing_id::text,
    EXISTS (SELECT 1 FROM product_sync r WHERE r.status = 'removed'
      AND r.supply_smart_product_id = ps.supply_smart_product_id) AS product_removed
  FROM latest q JOIN product_sync ps ON ps.channel = q.channel AND ps.listing_id = q.listing_id
    AND ps.variant_key = coalesce(q.variant_id, '')
  WHERE q.reason = 'PRODUCT.NOT_SUPPLEMENT' AND ps.supply_smart_product_id IS NOT NULL
    AND ps.status <> 'removed' AND ps.material_at IS NOT NULL
    AND ($3::text IS NULL OR (ps.channel, ps.listing_id, ps.variant_key) > ($3, $4, $5))
  ORDER BY ps.channel, ps.listing_id, ps.variant_key LIMIT $2`;

export async function notSupplementsDelivered(
  database: Queryable,
  filter: NotSupplementFilter,
): Promise<NotSupplementDelivered[]> {
  const { after } = filter;
  const rows = await database.query<Row>(NOT_SUPPLEMENTS_DELIVERED, [
    filter.channel ?? null,
    filter.limit,
    after?.channel ?? null,
    after?.listingId ?? null,
    after ? (after.variantId ?? "") : null,
  ]);
  return rows.map((row) => ({
    channel: row.channel,
    listingId: row.listing_id,
    variantId: row.variant_key === "" ? null : row.variant_key,
    supplySmartProductId: row.supply_smart_product_id,
    supplySmartListingId: row.supply_smart_listing_id,
    productRemoved: row.product_removed,
  }));
}

/** Only the status changes: the IDs and material time stay, so the sweep's watermark is exactly as it was. */
export async function markRemoved(database: Queryable, key: SyncKey): Promise<void> {
  await database.query(
    `UPDATE product_sync SET status = 'removed', error = NULL, updated_at = clock_timestamp()
     WHERE channel = $1 AND listing_id = $2 AND variant_key = $3`,
    [key.channel, key.listingId, key.variantId ?? ""],
  );
}
