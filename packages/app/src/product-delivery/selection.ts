import type { DeliveryProduct } from "./ports.js";
import { productDeliveryErrors } from "./errors.js";

export type ReadyDeliveryProduct = DeliveryProduct & {
  collection: NonNullable<DeliveryProduct["collection"]>;
  history: NonNullable<DeliveryProduct["history"]>;
  product: NonNullable<DeliveryProduct["product"]>;
};

export function readyDeliveryProduct(input: DeliveryProduct): ReadyDeliveryProduct {
  const { collection, history, product } = input;
  if (!collection || !history || !product || input.problem) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
  }
  const ready = { ...input, collection, history, product };
  assertOwner(ready);
  return ready;
}

function assertOwner(input: ReadyDeliveryProduct) {
  const { collection, history, product } = input;
  const owner = collection.observation;
  const checks = [
    product.channel === "dtc",
    history.listing.channel === "dtc",
    owner.sourceId === input.sourceId,
    owner.sourceId === history.owner.sourceId,
    owner.requestId === history.owner.runId,
    owner.listingId === history.listing.externalId,
    owner.variantId === history.capture.variantId,
    owner.listingId === product.listingId,
    owner.variantId === product.variantId,
  ];
  if (!checks.every(Boolean)) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
  }
}
