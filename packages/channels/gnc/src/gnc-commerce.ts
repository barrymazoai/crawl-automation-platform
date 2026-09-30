import { recordRecovery } from "@crawl-automation/platform";
import type { CommerceEvidence } from "@crawl-automation/channels-core";
import { DomUtils, parseDocument } from "htmlparser2";

type Document = ReturnType<typeof parseDocument>;
type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
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
function jsonLdProducts(document: Document): Json[] {
  const scripts = DomUtils.findAll(
    (element) => element.name === "script" && element.attribs["type"] === "application/ld+json",
    document.children,
  );
  return scripts.flatMap((script) => {
    try {
      const value: unknown = JSON.parse(DomUtils.textContent(script));
      const items = Array.isArray(value) ? value : [value];
      return items.filter((item): item is Json => isRecord(item) && item["@type"] === "Product");
    } catch (error) {
      recordRecovery(error, { operation: "gnc-commerce" });
      // A broken JSON-LD block carries no metrics; the product parser reports unreadable product data itself.
      return [];
    }
  });
}

/**
 * Price, rating, review count and availability as a GNC product page shows them (checked on the real 877080 page,
 * 2026-09-28): the `product:price:*` and `og:availability` meta tags, and the JSON-LD `aggregateRating`. A value
 * the page does not show stays null; nothing is inferred.
 */
export function gncCommerce(html: string, sku: string): CommerceEvidence {
  const document = parseDocument(html);
  const product = jsonLdProducts(document).find((item) => text(item["sku"]) === sku) ?? null;
  const rating = isRecord(product?.["aggregateRating"]) ? product["aggregateRating"] : null;
  const price = metaContent(document, "product:price:amount");
  return {
    codec: "public-product-commerce/1",
    sku,
    price,
    currency: metaContent(document, "product:price:currency"),
    listPrice: null,
    rating: text(rating?.["ratingValue"]),
    reviewCount: text(rating?.["reviewCount"]),
    availability: metaContent(document, "og:availability"),
    context: [],
    priceStatus: price ? "observed" : "not_observed",
  };
}
