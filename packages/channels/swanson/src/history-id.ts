import type { ParsedProduct } from "@crawl-automation/channels-core";

/** A Swanson SKU as the page states it, e.g. `HOR083`. */
const SKU = /^[A-Z][A-Z0-9-]{2,30}$/;

/**
 * The ID Swanson's metrics history keys a listing by, as the earlier history projection did: the page's SKU when it
 * is a real SKU, otherwise the selected Shopify variant.
 */
export function swansonExternalId(parsed: ParsedProduct): string {
  const sku = parsed.commerce?.sku?.trim() ?? "";
  return SKU.test(sku)
    ? sku
    : `shopify-variant:${parsed.identity.variantId ?? parsed.identity.listingId}`;
}
