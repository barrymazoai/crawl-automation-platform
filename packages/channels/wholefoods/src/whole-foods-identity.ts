import { object, parsePageJson, type FetchedPage } from "@crawl-automation/channels-core";
import { recordRecovery } from "@crawl-automation/platform";
import { parseHTML } from "linkedom";
import { wholeFoodsErrors } from "./whole-foods-errors.js";

/**
 * Real product pages (saved 2026-10-01) carry the selected product in `props.pageProps.aapiData`; other sizes
 * appear only under its `variationsList`. `product` is kept for the older page shape.
 */
function selectedProduct(data: ReturnType<typeof object>) {
  const page = object(object(data?.props)?.pageProps) ?? object(data?.pageData) ?? data;
  return object(page?.aapiData) ?? object(page?.product);
}

/** Only explicit selected-product roots; never URL echoes, store IDs or recommendations. */
function selectedAsin(text: string): string | null {
  try {
    const data = object(parsePageJson(text));
    const product = selectedProduct(data);
    const asin = product?.asin;
    return typeof asin === "string" && /^B0[A-Z0-9]{8}$/i.test(asin) ? asin.toUpperCase() : null;
  } catch (error) {
    recordRecovery(error, { operation: "wholefoods.page-identity" });
    return null;
  }
}

/** Bounded JSON paths still require live verification. Disagreement is unverified, never a requested ASIN. */
export function wholeFoodsPageIdentity(page: FetchedPage) {
  const { document } = parseHTML(page.html);
  const scripts = document.querySelectorAll(
    'script[type="application/json"], script#__NEXT_DATA__',
  );
  const asins = new Set([...scripts].map((script) => selectedAsin(script.textContent ?? "")));
  asins.delete(null);
  const listingId = asins.size === 1 ? [...asins][0] : null;
  return listingId ? { listingId, variantId: null } : null;
}

export function requireWholeFoodsIdentity(page: FetchedPage) {
  const identity = wholeFoodsPageIdentity(page);
  if (!identity) {
    throw wholeFoodsErrors.create("WHOLEFOODS.PRODUCT_UNVERIFIED", {
      details: { reason: "selected-product ASIN missing or ambiguous" },
    });
  }
  return identity;
}

const ASIN = /^B0[A-Z0-9]{8}$/i;

/**
 * The variation ASINs the selected product's own `variationsList` names explicitly (owner 2026-10-05). A node's
 * `closestAsin` is only a nearest match for an option combination, never that option's identity, so it is skipped.
 */
export function wholeFoodsVariationAsins(page: FetchedPage, selected: string): string[] {
  const { document } = parseHTML(page.html);
  const asins = new Set<string>();
  const scripts = document.querySelectorAll(
    'script[type="application/json"], script#__NEXT_DATA__',
  );
  for (const script of scripts) {
    for (const asin of scriptVariationAsins(script.textContent ?? "", selected)) {
      asins.add(asin);
    }
  }
  asins.delete(selected);
  return [...asins].sort();
}

function scriptVariationAsins(text: string, selected: string): string[] {
  try {
    const product = selectedProduct(object(parsePageJson(text)));
    if (typeof product?.asin !== "string" || product.asin.toUpperCase() !== selected) {
      return [];
    }
    const groups = Array.isArray(product.variationsList) ? product.variationsList : [];
    return groups.flatMap((group) => {
      const nodes = object(group)?.variationNodeList;
      return (Array.isArray(nodes) ? nodes : []).flatMap((node) => nodeAsin(node));
    });
  } catch (error) {
    recordRecovery(error, { operation: "wholefoods.variation-asins" });
    return [];
  }
}

function nodeAsin(node: unknown): string[] {
  const asin = object(node)?.asin;
  return typeof asin === "string" && ASIN.test(asin) ? [asin.toUpperCase()] : [];
}
