import { expect, it } from "vitest";
import type { ChannelPlanInput, DtcVariantHandoff } from "@crawl-automation/v3-contracts";
import { variantPages } from "./variant-pages.js";

it("records observed commerce for an unresolved/sold-out variant without default offer backfill", () => {
  const variant = {
    listingId: "hmw",
    variantId: "one",
    url: "https://shop.example/products/travel?variant=one",
    title: "One Week Supply",
    sku: "012",
    price: "9.99",
    available: false,
  };
  const member: DtcVariantHandoff = {
    status: "review",
    operationId: "one",
    variant,
    code: "DTC.VARIANT_EVIDENCE",
    reason: "Unknown label scope",
    evidence: ["page.html"],
  };
  const result = variantPages({
    variants: [member],
    base: {
      channel: "dtc",
      url: "https://shop.example/products/travel",
      listingId: "hmw",
      variantId: null,
      externalId: "hmw",
      capturedAt: "2026-10-02T12:00:00.000Z",
      commerce: null,
      archive: { objectKey: "html", sha256: "a".repeat(64) },
    },
    sourcePlan: {
      source: { objectKey: "base-projection", sha256: "b".repeat(64) },
    } as ChannelPlanInput,
    currency: undefined,
  });
  expect(result[0]).toMatchObject({
    operationId: "one",
    page: {
      variantId: "one",
      commerce: { sku: "012", price: "9.99", currency: null, availability: "OutOfStock" },
      archive: { objectKey: "base-projection", sha256: "b".repeat(64) },
    },
  });
});
