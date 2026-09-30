import {
  brandScanErrors,
  pageText,
  type ListedProduct,
  type ListingPage,
} from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { wholeFoodsProductAddress } from "./whole-foods-address.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import { assertStore, type WholeFoodsStore } from "./whole-foods-store.js";

/** Every product tile links to `/grocery/product/<slug>-<asin>`. */
export const WHOLE_FOODS_PRODUCT_LINK = 'a[href*="/grocery/product/"]';

/** A brand search as the browser drew it for the configured store. */
export interface WholeFoodsListing {
  page: ListingPage;
  /** False when the search says it has no results: the brand is not sold at this store. */
  soldHere: boolean;
}

function listedProduct(link: Element): ListedProduct {
  const href = link.getAttribute("href") ?? "";
  let address;
  try {
    address = wholeFoodsProductAddress(href);
  } catch (error) {
    throw brandScanErrors.create("BRAND_SCAN.TILE_IDENTITY", { cause: error, details: { href } });
  }
  const title = link.getAttribute("aria-label") ?? link.textContent?.replace(/\s+/g, " ").trim();
  return { ...address, title: title || null, kind: "product" };
}

/**
 * Reads a drawn brand search page: one product per ASIN, in page order. The whole list is on one page once the
 * browser has scrolled it to its end; whether it did is the scroll's outcome, not the page's (see the scan).
 */
export function parseWholeFoodsListing(html: string, store: WholeFoodsStore): WholeFoodsListing {
  const { document } = parseHTML(html);
  const products = new Map<string, ListedProduct>();
  for (const link of document.querySelectorAll(WHOLE_FOODS_PRODUCT_LINK)) {
    const product = listedProduct(link);
    if (!products.has(product.listingId)) {
      products.set(product.listingId, product);
    }
  }
  const text = pageText(html);
  const noResults = /No results for/i.test(text);
  if (products.size === 0 && !noResults) {
    throw wholeFoodsErrors.create("WHOLEFOODS.LISTING_UNVERIFIED");
  }
  assertStore(html, store);
  const listed = [...products.values()];
  return {
    page: { products: listed, cards: listed.length, nextPage: null, statedTotal: null },
    soldHere: listed.length > 0,
  };
}
