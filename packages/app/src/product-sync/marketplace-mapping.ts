import { z } from "zod";
import { canonicalHash } from "../history/canonical.js";
import { deliveryItem } from "../product-delivery/mapping.js";
import { deliveryLabel } from "../product-delivery/label-mapping.js";
import type { DeliveryItem, DeliveryLabel } from "../product-delivery/wire.js";
import { marketplaceReady } from "./marketplace-ownership.js";
import { marketplaceAttributes } from "./marketplace-attributes.js";
import type { MarketplaceMappingOptions, MarketplaceProduct } from "./marketplace-model.js";
export * from "./marketplace-model.js";

/** One item for ingestObservationBatch; channel belongs to the enclosing partial run. */
export function marketplaceItem(
  input: MarketplaceProduct,
  options: MarketplaceMappingOptions,
): DeliveryItem {
  const ready = marketplaceReady(input);
  const domain = z.string().trim().min(1).max(253).parse(options.domain);
  z.string().trim().min(1).max(200).parse(options.runId);
  const externalId = ready.product.variantId ?? ready.product.listingId;
  const item = deliveryItem(ready, {
    domain,
    clientRef: `sku-${canonicalHash([input.channel, externalId])}`,
  });
  // Unlike DTC, a retailer projection may omit the brand; the matched crawler brand is retained evidence.
  if (!item.brandName && input.brand.trim()) {
    item.brandName = input.brand.trim();
  }
  return marketplaceAttributes(ready, item);
}

/** Null is a real absence, especially for Whole Foods; it never manufactures a formula. */
export function marketplaceLabel(
  input: MarketplaceProduct,
  options: MarketplaceMappingOptions,
): DeliveryLabel | null {
  const item = marketplaceItem(input, options);
  if (!input.collection) {
    return null;
  }
  const label = deliveryLabel({
    item,
    collection: input.collection,
    channel: input.channel,
    company: {
      domain: item.domain,
      ...(options.companyId ? { expectedCompanyId: options.companyId } : {}),
    },
  });
  return input.channel === "wholefoods" ? wholeFoodsLabel(input, label) : label;
}

function wholeFoodsLabel(input: MarketplaceProduct, label: DeliveryLabel): DeliveryLabel {
  // Distinct from Amazon's observation/operation even when both submit the same assembly.
  const identity = canonicalHash([
    input.channel,
    input.history?.observationId,
    input.collection?.operationId,
  ]);
  const capturedAt = z.iso.datetime({ offset: true }).parse(input.labelHistory?.capturedAt);
  const listing = labelListingWithoutCommerce(label);
  return {
    ...label,
    submitter: { namespace: "crawler-v3", operationId: `label-${identity}` },
    observation: {
      ...label.observation,
      observationId: `wholefoods-label-${identity}`,
      capturedAt,
    },
    // The label's time is Amazon's original time, so do not backdate Whole Foods commerce to it.
    listing: {
      ...listing,
      extras: {
        labelSource: {
          channel: "amazon",
          observation: input.collection?.observation,
          capturedAt,
          targetCapture: input.history?.observationId,
        },
      },
    },
  };
}

function labelListingWithoutCommerce(label: DeliveryLabel) {
  const {
    price: _price,
    currency: _currency,
    inStock: _stock,
    listPrice: _list,
    rating: _rating,
    reviewCount: _reviews,
    salesRank: _rank,
    unitsSold: _sold,
    unitsSoldPeriod: _period,
    extras: _extras,
    ...listing
  } = label.listing;
  return listing;
}
