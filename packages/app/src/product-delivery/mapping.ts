import { z } from "zod";
import { canonicalHash } from "../history/canonical.js";
import type { ProductDeliveryRequest } from "../brand-enrichment/task-ports.js";
import type { DeliveryProduct } from "./ports.js";
import { readyDeliveryProduct, type ReadyDeliveryProduct } from "./selection.js";
import { deliveryLabel } from "./label-mapping.js";
import { deliverySemantics } from "./semantic-mapping.js";
import type { DeliveryItem, MappedDelivery } from "./wire.js";
import { productDeliveryErrors } from "./errors.js";

export function mapDeliveryProduct(
  input: DeliveryProduct,
  request: ProductDeliveryRequest,
): MappedDelivery {
  const ready = readyDeliveryProduct(input);
  const hostname = new URL(ready.product.url).hostname.toLowerCase();
  if (
    !request.sourceIds.includes(ready.sourceId) ||
    (hostname !== request.siteKey && !hostname.endsWith(`.${request.siteKey}`))
  ) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
  }
  const { collection } = ready;
  const item = mapListing(ready, request);
  return {
    item,
    label: deliveryLabel({
      item,
      collection,
      company: {
        domain: request.siteKey,
        expectedCompanyId: request.companyId,
      },
      channel: "dtc",
    }),
  };
}

function mapListing(input: ReadyDeliveryProduct, request: ProductDeliveryRequest): DeliveryItem {
  return deliveryItem(input, {
    domain: request.siteKey,
    siteKey: request.siteKey,
    clientRef: `sku-${canonicalHash([request.siteKey, input.product.variantId ?? input.product.listingId])}`,
  });
}

/** Shared wire mapping; each caller validates its channel's ownership before entering. */
export function deliveryItem(
  input: Pick<ReadyDeliveryProduct, "product" | "history" | "enrichment" | "sourceId"> & {
    collection: DeliveryProduct["collection"];
  },
  target: { domain: string; siteKey?: string; clientRef: string },
): DeliveryItem {
  const { collection, product, history } = input;
  const variant = product.variants.find(
    (entry) => entry.listingId === product.listingId && entry.variantId === product.variantId,
  );
  return {
    ...target,
    externalId: product.variantId ?? product.listingId,
    sourceUrl: variant?.url ?? history.listing.url,
    productUrl: product.url,
    productName: input.enrichment?.candidate.unifiedName ?? product.title,
    titleRaw: product.title,
    ...listingBrand(product.brandRaw, target.domain),
    capturedAt: z.iso.datetime({ offset: true }).parse(history.capturedAt),
    ...deliverySemantics(input.enrichment),
    ...observedMetrics(history.metrics),
    attrsRaw: {
      variantOptions: product.variantOptions,
      websiteVariants: product.variants,
      ...(variant ? { websiteVariant: variant } : {}),
    },
    extras: {
      ...(history.metrics.extras as object),
      crawler: collectionIdentity(input.sourceId, collection),
    },
    images: product.imageCandidates
      .filter((image) => image.variantId === null || image.variantId === product.variantId)
      .map((image, index) => ({ clientRef: `gallery-${index}`, url: image.url, role: "gallery" })),
  };
}

function listingBrand(raw: string | null, siteKey: string) {
  const brand = raw?.trim();
  return brand && brand !== siteKey ? { brandName: brand } : {};
}

const metricNumber = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d+(?:\.\d+)?$/u)
      .transform(Number),
  ])
  .pipe(z.number().finite());
const metricInteger = metricNumber.pipe(
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);

function observedMetrics(metrics: Record<string, unknown>) {
  const schema = z
    .object({
      price: z.string(),
      currency: z.string(),
      listPrice: z.string(),
      rating: metricNumber,
      reviewCount: metricInteger,
      salesRank: metricInteger,
      inStock: z.boolean(),
      unitsSold: metricInteger,
      unitsSoldPeriod: z.enum(["trailing_30d", "monthly", "lifetime", "unknown"]),
    })
    .partial();
  return schema.parse(
    Object.fromEntries(Object.entries(metrics).filter(([, value]) => value != null)),
  );
}

function collectionIdentity(sourceId: string, collection: DeliveryProduct["collection"]) {
  return {
    sourceId,
    ...(collection
      ? { operationId: collection.operationId, observationId: collection.observation.observationId }
      : {}),
  };
}
