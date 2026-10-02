import {
  jsonLdProducts,
  object,
  parsePageJson,
  schemaCommerce,
  type CommerceEvidence,
} from "@crawl-automation/channels-core";
import type { swansonIdentityMapping } from "./identity-map.js";
import { SWANSON_ORIGIN } from "./swanson-address.js";
import {
  SWANSON_RECOMMENDATIONS,
  swansonMetaProduct,
  swansonProductElements,
} from "./swanson-shopify-selection.js";

export type CommerceOwner = ReturnType<typeof swansonIdentityMapping>;
export type StockSignal = { source: string; value: unknown };
export type CommerceData = { offers: CommerceEvidence[]; stock: StockSignal[] };

/** Shopify's schema uses /products/ while the canonical page uses /p/. */
function ownUrl(value: unknown, owner: CommerceOwner): URL | null {
  if (typeof value !== "string" || !URL.canParse(value, SWANSON_ORIGIN)) {
    return null;
  }
  const url = new URL(value, SWANSON_ORIGIN);
  const handle = url.pathname.match(/^\/(?:p|products)\/([^/]+)$/)?.[1];
  return url.origin === SWANSON_ORIGIN && handle === owner.handle ? url : null;
}

function selectedUrl(value: unknown, owner: CommerceOwner): boolean {
  const url = ownUrl(value, owner);
  const variants = url?.searchParams.getAll("variant");
  return variants?.length === 1 && variants[0] === owner.variantId;
}

function schemaOffers(document: Document, owner: CommerceOwner): CommerceEvidence[] {
  const ownDocument = document.cloneNode(true) as Document;
  for (const element of ownDocument.querySelectorAll(SWANSON_RECOMMENDATIONS)) {
    element.remove();
  }
  return jsonLdProducts(ownDocument)
    .filter((product) => ownUrl(product.url, owner))
    .flatMap((product) => (Array.isArray(product.offers) ? product.offers : [product.offers]))
    .map(object)
    .filter((offer) => offer !== null && selectedUrl(offer.url, owner))
    .map((offer) => schemaCommerce(offer ?? {}));
}

function metaVariant(document: Document, owner: CommerceOwner): Record<string, unknown> | null {
  const product = swansonMetaProduct(document);
  if (String(product?.id) !== owner.productId || product?.handle !== owner.handle) {
    return null;
  }
  const variants = Array.isArray(product.variants) ? product.variants.map(object) : [];
  const matches = variants.filter((variant) => String(variant?.id) === owner.variantId);
  const variant = matches.length === 1 ? matches[0] : null;
  return variant
    ? {
        ...variant,
        productAvailable: variants.length === 1 ? product.available : undefined,
      }
    : null;
}

/** Picker JSON is a selected variant record, not arbitrary application/json analytics data. */
function pickerVariants(document: Document, owner: CommerceOwner) {
  return swansonProductElements(document, 'main variant-picker script[type="application/json"]')
    .filter(
      (script) =>
        script.closest("variant-picker")?.getAttribute("data-product-id") === owner.productId,
    )
    .map((script) => object(parsePageJson(script.textContent ?? "")))
    .filter((variant) => String(variant?.id) === owner.variantId);
}

export function swansonCommerceData(document: Document, owner: CommerceOwner): CommerceData {
  const offers = schemaOffers(document, owner);
  const variants = [metaVariant(document, owner), ...pickerVariants(document, owner)];
  const stock: StockSignal[] = offers.map((offer) => ({
    source: "JSON-LD offer",
    value: offer.availability,
  }));
  for (const variant of variants) {
    if (!variant) {
      continue;
    }
    stock.push({ source: "Shopify variant.available", value: variant.available });
    stock.push({
      source: "Shopify product.available (sole variant)",
      value: variant.productAvailable,
    });
    const price =
      typeof variant.price === "number" && Number.isSafeInteger(variant.price)
        ? (variant.price / 100).toFixed(2)
        : null;
    offers.push(schemaCommerce({ price }));
  }
  return { offers, stock };
}
