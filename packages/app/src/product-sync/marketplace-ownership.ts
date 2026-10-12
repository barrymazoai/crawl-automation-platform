import { canonicalHash } from "../history/canonical.js";
import { productDeliveryErrors } from "../product-delivery/errors.js";
import type { MarketplaceProduct } from "./marketplace-model.js";

export function marketplaceReady(input: MarketplaceProduct) {
  const { history, product } = input;
  if (!history || !product || input.problem) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
  }
  assertMarketplaceOwner([
    history.listing.channel === input.channel,
    product.channel === input.channel,
    history.owner.runId === input.runId,
    history.owner.sourceId === input.sourceId,
    history.capture.variantId === input.variantId,
    samePage(history.listing.url, input.url),
    samePage(product.url, history.listing.url),
    input.variantId === null || product.variantId === input.variantId,
    // Swanson's handle, commerce SKU and Shopify ID have different namespaces.
    input.channel === "swanson" || product.listingId === input.listingId,
    input.channel === "swanson" || history.listing.externalId === input.listingId,
  ]);
  const ready = { ...input, history, product };
  if (input.collection) {
    assertCollection(ready, input.collection);
  }
  assertEnrichment(input);
  return ready;
}

function assertCollection(
  input: ReturnTypeWithoutCollection,
  collection: NonNullable<MarketplaceProduct["collection"]>,
) {
  const owner = collection.observation;
  if (input.channel === "wholefoods") {
    const donor = input.labelHistory;
    assertMarketplaceOwner([
      donor?.listing.channel === "amazon",
      donor?.listing.externalId === input.listingId,
      donor?.owner.runId === owner.requestId,
      donor?.owner.sourceId === owner.sourceId,
      donor?.capture.variantId === owner.variantId,
      owner.listingId === input.listingId,
      owner.variantId === null || owner.variantId === input.listingId,
    ]);
    return;
  }
  assertMarketplaceOwner([
    owner.requestId === input.runId,
    owner.sourceId === input.sourceId,
    owner.listingId === input.product.listingId,
    owner.variantId === input.product.variantId,
  ]);
}
type ReturnTypeWithoutCollection = MarketplaceProduct & {
  product: NonNullable<MarketplaceProduct["product"]>;
};
export function assertMarketplaceOwner(checks: boolean[]): void {
  if (!checks.every(Boolean)) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
  }
}
function samePage(left: string, right: string) {
  const first = new URL(left);
  const second = new URL(right);
  return first.origin === second.origin && first.pathname === second.pathname;
}

function assertEnrichment(input: MarketplaceProduct) {
  if (input.enrichment) {
    assertMarketplaceOwner([
      input.enrichment.subject.collectionOperationId === input.collection?.operationId,
      input.enrichment.subject.listingId === input.collection?.observation.listingId,
      input.enrichment.subject.variantId === input.collection?.observation.variantId,
      canonicalHash(input.enrichment.subject.observation) ===
        canonicalHash(input.collection?.observation),
      input.enrichment.subject.channel ===
        (input.channel === "wholefoods" ? "amazon" : input.channel),
    ]);
  }
}
