import { pageText, type FetchedPage } from "@crawl-automation/channels-core";
import { wholeFoodsContent } from "./whole-foods-content.js";
import { parseHTML } from "linkedom";
import { wholeFoodsProductAddress } from "./whole-foods-address.js";
import { requireWholeFoodsIdentity } from "./whole-foods-identity.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import { assertStore, type WholeFoodsStore } from "./whole-foods-store.js";

/** What a Whole Foods product page shows for the configured store; the formula comes from Amazon by ASIN. */
export interface WholeFoodsProduct {
  codec: "wholefoods-product/1";
  asin: string;
  url: string;
  title: string;
  brandRaw: string | null;
  images: string[];
  factsText: string | null;
  detailsHtml: string | null;
  /** The price shown under the title, as printed (`$41.30`); null when none is shown. */
  price: string | null;
  availability: "available" | "unavailable" | null;
  storeId: string;
  storeLabel: string;
  capturedAt: string;
}

const PRICE = /\$\d{1,5}(?:,\d{3})*\.\d{2}/;
const UNAVAILABLE = /currently unavailable|not available at|out of stock|currently not sold in/i;
/** How far below the title the price and availability are read (the 2026-09-28 checks found them there). */
const BLOCK_CHARACTERS = 400;

/** The text shown right below the title. */
function blockAfterTitle(text: string, title: string): string {
  const at = text.indexOf(title);
  const start = at >= 0 ? at + title.length : 0;
  return text.slice(start, start + BLOCK_CHARACTERS);
}

/**
 * Reads retained HTTP HTML for the configured store. Confirm on a real saved HTTP page:
 * h1 (title), the next 400 text characters (price/availability), and the store ID in the
 * page data. Additional product selectors and JSON paths
 * requiring confirmation are listed in whole-foods-content.ts and whole-foods-structured.ts.
 */
export function parseWholeFoodsProduct(
  page: FetchedPage,
  store: WholeFoodsStore,
): WholeFoodsProduct {
  const address = wholeFoodsProductAddress(page.url);
  const identity = requireWholeFoodsIdentity(page);
  const { document } = parseHTML(page.html);
  const content = wholeFoodsContent(document, { asin: identity.listingId, url: address.url });
  const title =
    document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() || content.title;
  if (!title) {
    throw wholeFoodsErrors.create("WHOLEFOODS.PRODUCT_UNVERIFIED", {
      details: { url: address.url },
    });
  }
  const text = pageText(page.html);
  assertStore(page.html, store);
  const block = blockAfterTitle(text, title);
  return {
    codec: "wholefoods-product/1",
    asin: identity.listingId,
    url: address.url,
    ...content,
    title,
    price: PRICE.exec(block)?.[0] ?? null,
    availability: UNAVAILABLE.test(block)
      ? "unavailable"
      : PRICE.test(block) || /add to cart/i.test(block)
        ? "available"
        : null,
    storeId: store.storeId,
    storeLabel: store.label,
    capturedAt: page.capturedAt,
  };
}
