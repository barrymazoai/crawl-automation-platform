import { readFileSync } from "node:fs";
import type {
  DeliveryProduct,
  DeliverySnapshot,
  ProductDeliveryRequest,
} from "@crawl-automation/app";
import { LabelCollectedProductSchema } from "@crawl-automation/v3-contracts";

const original = LabelCollectedProductSchema.parse(
  JSON.parse(
    readFileSync(new URL("../postgres/fixtures/collected-product.json", import.meta.url), "utf8"),
  ),
);

export const deliveryRequest: ProductDeliveryRequest = {
  companyId: "418c0962-2388-4ebd-bf54-51f8a844f6a4",
  sourceIds: ["source"],
  siteKey: "example.com",
  ingestRunId: "brand-enrichment-test",
};

export function deliveryProduct(suffix = "1"): DeliveryProduct {
  const collection = structuredClone(original);
  collection.operationId = `label-${suffix}`;
  collection.observation = {
    ...collection.observation,
    listingId: `product-${suffix}`,
    observationId: `observation-${suffix}`,
    variantId: `variant-${suffix}`,
  };
  const url = `https://example.com/products/focusfuel?variant=variant-${suffix}`;
  return {
    queueId: `queue-${suffix}`,
    batchId: "scan",
    sourceId: "source",
    externalId: `variant-${suffix}`,
    collection,
    enrichment: null,
    history: {
      capturedAt: "2026-10-09T02:00:00.000Z",
      owner: { runId: "request", sourceId: "source" },
      listing: { channel: "dtc", externalId: `product-${suffix}`, url },
      capture: { variantId: `variant-${suffix}` },
      metrics: { price: "24.00", currency: "USD", inStock: false, rating: null, extras: {} },
      evidence: [],
    },
    product: evidence(suffix, url),
  };
}

function evidence(suffix: string, url: string): NonNullable<DeliveryProduct["product"]> {
  return {
    codec: "channel-product/1",
    channel: "dtc",
    listingId: `product-${suffix}`,
    variantId: `variant-${suffix}`,
    url,
    title: "FocusFuel Gummies 30 Count",
    brandRaw: "FocusFuel",
    variantOptions: ["30 Count"],
    variants: [
      {
        listingId: `product-${suffix}`,
        variantId: `variant-${suffix}`,
        url,
        title: "30 Count",
        sku: "FF30",
      },
    ],
    detailsHtml: null,
    factsCandidates: [],
    warnings: [],
    imageCandidates: images(suffix),
  };
}

function images(suffix: string): NonNullable<DeliveryProduct["product"]>["imageCandidates"] {
  return [
    {
      url: "https://example.com/facts.jpg",
      variantId: `variant-${suffix}`,
      basis: "selected-gallery",
      verifiedOriginal: false,
    },
    {
      url: "https://example.com/other.jpg",
      variantId: "other-sku",
      basis: "variant-featured",
      verifiedOriginal: false,
    },
  ];
}

export function deliverySnapshot(products = [deliveryProduct()]): DeliverySnapshot {
  return {
    products,
    review: 0,
    pending: 0,
    scans: [
      {
        sourceId: "source",
        siteKey: "example.com",
        siteScope: "single-brand",
        scanId: "scan",
        startedAt: "2026-10-09T01:00:00.000Z",
        state: "complete",
        full: true,
        capped: false,
        unresolvedFamilies: 0,
        products: products.length,
        queued: products.length,
        recent: 0,
      },
    ],
  };
}
