import { expect, it } from "vitest";
import { selectDeliverySettlement } from "@crawl-automation/app";
import { deliveryProduct } from "./product.fixture.js";

it("excludes a variant's enrichment Review even when its parent queue and formula are completed", () => {
  const result = selectDeliverySettlement({
    products: [deliveryProduct("1"), deliveryProduct("2")],
    queueReview: false,
    holds: [
      { kind: "review", operationId: "label-1", listingId: "product-1", variantId: "variant-1" },
      { kind: "pending", operationId: "label-1", listingId: "product-1", variantId: "variant-1" },
    ],
  });
  expect(result).toMatchObject({ products: [{ externalId: "variant-2" }], review: 1, pending: 0 });
  expect(result.products).toHaveLength(1);
});

it("does not deliver an enrichment attempt still pending, or any queue still in Review", () => {
  const product = deliveryProduct();
  expect(
    selectDeliverySettlement({
      products: [product],
      queueReview: false,
      holds: [
        { kind: "pending", operationId: "label-1", listingId: "product-1", variantId: "variant-1" },
      ],
    }),
  ).toEqual({ products: [], review: 0, pending: 1 });
  expect(selectDeliverySettlement({ products: [product], queueReview: true, holds: [] })).toEqual({
    products: [],
    review: 1,
    pending: 0,
  });
});
