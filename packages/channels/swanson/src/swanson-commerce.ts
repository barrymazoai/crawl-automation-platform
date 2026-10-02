import { schemaCommerce, type CommerceEvidence } from "@crawl-automation/channels-core";
import type { SwansonRenderedProduct } from "@crawl-automation/v3-contracts";
import { swansonIdentityMapping } from "./identity-map.js";
import { swansonCommerceData } from "./swanson-commerce-data.js";
import { swansonCommerceRoot, swansonDomStock, swansonStock } from "./swanson-commerce-stock.js";
import { swansonProductElements } from "./swanson-shopify-selection.js";

function numericPrice(value: string): string {
  return /^\$\s*\d+(?:,\d{3})*(?:\.\d{2})?$/.test(value) ? value.replace(/[$,\s]/g, "") : value;
}

function printedPrice(value: string | null | undefined): CommerceEvidence {
  const text = value?.trim() ?? null;
  const parsed = schemaCommerce({ price: text === null ? null : numericPrice(text) });
  return { ...parsed, price: parsed.price === null ? null : text };
}

function priceData(root: Element | null): CommerceEvidence[] {
  const detailPrice = root?.getAttribute("data-cnstrc-item-price");
  const prices = [...(root?.querySelectorAll('[itemprop="price"]') ?? [])].map(
    (element) => element.getAttribute("content") || element.textContent,
  );
  return [...prices, detailPrice].map(printedPrice);
}

function fallbackPrice(offers: CommerceEvidence[]) {
  const prices = offers.map((offer) => offer.price).filter((price) => price !== null);
  const distinct = new Set(prices.map((price) => Number(numericPrice(price))));
  const currencies = [...new Set(offers.map((offer) => offer.currency).filter(Boolean))];
  const ambiguous = distinct.size > 1 || currencies.length > 1;
  return {
    price: ambiguous ? null : (prices[0] ?? null),
    currency: currencies.length === 1 ? (currencies[0] ?? null) : null,
    reasons: ambiguous ? ["price: conflicting product-owned prices or currencies"] : [],
  };
}

function preserveCartCommerce(
  document: Document,
  original: CommerceEvidence,
  state: string | null,
) {
  return (
    original.price !== null &&
    state === "available" &&
    swansonProductElements(document, "product-form-component[data-product-id]").length > 0
  );
}

/** Swanson records the schema.org words its in-stock pages have always used. */
function swansonStockWord(state: string | null): string | null {
  return state === "available" ? "InStock" : state === "unavailable" ? "OutOfStock" : null;
}

/** Keep selected purchase-plan prices verbatim; only fill their absence from owned product data. */
export function swansonCommerce(
  document: Document,
  identity: Pick<SwansonRenderedProduct, "canonicalUrl" | "selectedForms">,
  original: CommerceEvidence,
): CommerceEvidence {
  if (!identity.canonicalUrl) {
    return original; // The projection schema retains the existing missing-canonical error.
  }
  const owner = swansonIdentityMapping(identity);
  const root = swansonCommerceRoot(document, owner);
  const data = swansonCommerceData(document, owner);
  const stock = swansonStock([...data.stock, ...swansonDomStock(root, owner)]);
  // Keep established in-stock cart-form captures byte-for-byte compatible; never hide a conflict.
  if (preserveCartCommerce(document, original, stock.availability)) {
    return original;
  }
  const fallback = fallbackPrice([...priceData(root), ...data.offers]);
  const selectedPrice = root?.querySelector(
    ".product-form-plan-option.selected .product-form-plan-option-price--current",
  );
  const keepPrice = selectedPrice || original.price !== null;
  const reasons = [...stock.reasons, ...(keepPrice ? [] : fallback.reasons)];
  return {
    ...original,
    price: keepPrice ? original.price : fallback.price,
    currency: original.currency ?? (keepPrice ? null : fallback.currency),
    availability: swansonStockWord(stock.availability),
    context: [...original.context.slice(0, 20 - reasons.length), ...reasons],
  };
}
