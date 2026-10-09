import type { DeliveryProduct, ProductDeliveryHold } from "./ports.js";

export function selectDeliverySettlement(input: {
  products: DeliveryProduct[];
  holds: ProductDeliveryHold[];
  queueReview: boolean;
}) {
  const reviews = new Set<string>();
  const pending = new Set<string>();
  for (const hold of input.holds) {
    const key = JSON.stringify([hold.listingId, hold.variantId]);
    (hold.kind === "review" ? reviews : pending).add(key);
  }
  const products = input.queueReview
    ? []
    : input.products.filter((product) => !input.holds.some((hold) => heldProduct(product, hold)));
  return {
    products,
    review: Math.max(reviews.size, Number(input.queueReview)),
    pending: [...pending].filter((key) => !reviews.has(key)).length,
  };
}

function heldProduct(product: DeliveryProduct, hold: ProductDeliveryHold) {
  if (product.operationId === hold.operationId) {
    return true;
  }
  const collection = product.collection;
  if (!collection) {
    return false;
  }
  return (
    collection.operationId === hold.operationId ||
    (collection.observation.listingId === hold.listingId &&
      collection.observation.variantId === hold.variantId)
  );
}
