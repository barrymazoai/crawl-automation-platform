import { z } from "zod";
import { canonicalHash } from "../history/canonical.js";
import type { ProductDeliveryRequest } from "../brand-enrichment/task-ports.js";
import type { DeliveryProduct } from "./ports.js";
import { readyDeliveryProduct, type ReadyDeliveryProduct } from "./selection.js";
import { deliveryLabelContent, deliveryLabelEvidence } from "./label-mapping.js";
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
  const { clientRef: _clientRef, domain: _domain, capturedAt, images, ...listing } = item;
  const { schemaVersion: _schemaVersion, ...observation } = collection.observation;
  return {
    item,
    label: {
      schemaVersion: 1,
      submitter: {
        namespace: "crawler-v3",
        operationId: `label-${canonicalHash(collection.operationId)}`,
      },
      observation: { ...observation, capturedAt },
      company: { domain: request.siteKey, expectedCompanyId: request.companyId },
      channel: "dtc",
      source: "crawler-v3:product-delivery",
      listing,
      images: images.slice(0, 50),
      label: {
        content: deliveryLabelContent(collection),
        evidence: deliveryLabelEvidence(collection),
      },
    },
  };
}

function mapListing(input: ReadyDeliveryProduct, request: ProductDeliveryRequest): DeliveryItem {
  const { collection, product, history } = input;
  const variant = product.variants.find((entry) => entry.variantId === product.variantId);
  const externalId = product.variantId ?? product.listingId;
  return {
    clientRef: `sku-${canonicalHash([request.siteKey, externalId])}`,
    domain: request.siteKey,
    siteKey: request.siteKey,
    externalId,
    sourceUrl: variant?.url ?? history.listing.url,
    productUrl: product.url,
    productName: input.enrichment?.candidate.unifiedName ?? product.title,
    titleRaw: product.title,
    ...listingBrand(product.brandRaw, request.siteKey),
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
      crawler: {
        sourceId: input.sourceId,
        operationId: collection.operationId,
        observationId: collection.observation.observationId,
      },
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

function observedMetrics(metrics: Record<string, unknown>) {
  const schema = z
    .object({
      price: z.string(),
      currency: z.string(),
      listPrice: z.string(),
      rating: z.number(),
      reviewCount: z.number().int(),
      salesRank: z.number().int(),
      inStock: z.boolean(),
      unitsSold: z.number().int(),
      unitsSoldPeriod: z.enum(["trailing_30d", "monthly", "lifetime", "unknown"]),
    })
    .partial();
  return schema.parse(
    Object.fromEntries(Object.entries(metrics).filter(([, value]) => value != null)),
  );
}
