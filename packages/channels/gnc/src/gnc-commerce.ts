import { recordRecovery } from "@crawl-automation/platform";
import type { CommerceEvidence } from "@crawl-automation/channels-core";
import { DomUtils, parseDocument } from "htmlparser2";
import { jsonLdProducts, productRecord, isRecord, type JsonRecord } from "./gnc-json-ld.js";
import { gncPageErrors } from "./gnc-page-errors.js";

type Document = ReturnType<typeof parseDocument>;
const text = (value: unknown): string | null =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() || null : null;

/** The content of `<meta property="…">` (Open Graph and product tags). */
function metaContent(document: Document, property: string): string | null {
  const meta = DomUtils.findOne(
    (element) => element.name === "meta" && element.attribs["property"] === property,
    document.children,
  );
  return text(meta?.attribs["content"]);
}

/** Every JSON-LD `Product` object on the page (ignoring blocks that do not parse). */
function commerceProducts(document: Document): JsonRecord[] {
  const scripts = DomUtils.findAll(
    (element) => element.name === "script" && element.attribs["type"] === "application/ld+json",
    document.children,
  );
  return scripts.flatMap((script) => {
    try {
      return jsonLdProducts([script]).products;
    } catch (error) {
      if (!gncPageErrors.is(error, "GNC.JSON_INVALID")) {
        throw error;
      }
      recordRecovery(error.cause, { operation: "gnc-commerce" });
      // A broken JSON-LD block carries no metrics; the product parser reports unreadable product data itself.
      return [];
    }
  });
}

/**
 * Price, rating, review count and availability as a GNC product page shows them (checked on the real 877080 page,
 * 2026-09-28): meta tags and the merged SKU's JSON-LD offers and rating. A value the page does not show stays null.
 */
export function gncCommerce(html: string, sku: string): CommerceEvidence {
  const document = parseDocument(html);
  const matches = commerceProducts(document).filter((item) => text(item.sku) === sku);
  const product = matches.length ? productRecord(matches, sku) : {};
  const rating = isRecord(product.aggregateRating) ? product.aggregateRating : {};
  const offer = isRecord(product.offers) ? product.offers : {};
  const price = metaContent(document, "product:price:amount") ?? text(offer.price);
  return {
    codec: "public-product-commerce/1",
    sku,
    price,
    currency: metaContent(document, "product:price:currency") ?? text(offer.priceCurrency),
    listPrice: null,
    rating: text(rating.ratingValue),
    reviewCount: text(rating.reviewCount),
    availability: metaContent(document, "og:availability") ?? text(offer.availability),
    context: [],
    priceStatus: price ? "observed" : "not_observed",
  };
}
