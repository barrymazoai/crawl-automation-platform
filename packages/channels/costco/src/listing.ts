import {
  brandScanErrors,
  pageText,
  type DrawnListing,
  type ListedProduct,
} from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { costcoProductAddress } from "./address.js";
import { costcoErrors } from "./errors.js";
import { verifyCostcoStore, type CostcoStore } from "./store.js";

export const COSTCO_TILE = '[data-testid^="ProductTile_"]';
export const COSTCO_PRODUCT_LINK = `${COSTCO_TILE} a[href*=".product."]`;

function productOf(link: Element): ListedProduct {
  const href = link.getAttribute("href") ?? "";
  try {
    const address = costcoProductAddress(href);
    const tileId = link.closest(COSTCO_TILE)?.getAttribute("data-testid")?.slice(12);
    if (tileId && tileId !== address.listingId) {
      throw costcoErrors.create("COSTCO.IDENTITY_UNVERIFIED");
    }
    const title = link.getAttribute("aria-label") || link.textContent?.trim() || null;
    return { ...address, title, kind: "product" };
  } catch (cause) {
    throw brandScanErrors.create("BRAND_SCAN.TILE_IDENTITY", { cause, details: { href } });
  }
}

function tileLinks(document: Document): Element[] {
  return [...document.querySelectorAll(COSTCO_TILE)].flatMap((tile) => {
    const links = [...tile.querySelectorAll('a[href*=".product."]')];
    if (!links.length) {
      throw brandScanErrors.create("BRAND_SCAN.TILE_IDENTITY", {
        details: { tile: tile.getAttribute("data-testid") },
      });
    }
    return links;
  });
}

/** Retained item fragments are already scoped by the browser's product-tile selector. */
export function parseCostcoListing(
  html: string,
  store: CostcoStore,
  observedItems: readonly { html: string }[] = [],
): DrawnListing {
  const { document } = parseHTML(html);
  const retained = observedItems.flatMap((item) => [
    ...parseHTML(item.html).document.querySelectorAll('a[href*=".product."]'),
  ]);
  const products = new Map<string, ListedProduct>();
  for (const link of [...retained, ...tileLinks(document)]) {
    const product = productOf(link);
    if (!products.has(product.listingId)) {
      products.set(product.listingId, product);
    }
  }
  const text = pageText(document.querySelector("main")?.outerHTML ?? html);
  const total = /\b(\d[\d,]*)\s+results?\b/i.exec(text)?.[1];
  const empty = /\bno (?:results|products)(?:\s+found)?\b|\b0 results\b/i.test(text);
  if (!products.size && !empty) {
    throw costcoErrors.create("COSTCO.LISTING_UNVERIFIED");
  }
  verifyCostcoStore(html, store, true);
  const listed = [...products.values()];
  return {
    page: {
      products: listed,
      cards: listed.length,
      nextPage: null,
      statedTotal: total ? Number(total.replaceAll(",", "")) : null,
    },
    soldHere: listed.length > 0,
  };
}
