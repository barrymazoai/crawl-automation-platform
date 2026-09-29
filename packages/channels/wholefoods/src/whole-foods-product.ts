import { pageText, type FetchedPage } from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { wholeFoodsProductAddress } from "./whole-foods-address.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import { assertStore, type WholeFoodsStore } from "./whole-foods-store.js";

/** What a Whole Foods product page shows for the configured store; the formula comes from Amazon by ASIN. */
export interface WholeFoodsProduct {
  codec: "wholefoods-product/1";
  asin: string;
  url: string;
  title: string;
  /** The price shown under the title, as printed (`$41.30`); null when none is shown. */
  price: string | null;
  availability: "available" | "unavailable";
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
 * Reads one drawn product page for the configured store: title, the price and availability below it, and the
 * store the page is priced for, which must be the configured one.
 */
export function parseWholeFoodsProduct(
  page: FetchedPage,
  store: WholeFoodsStore,
): WholeFoodsProduct {
  const address = wholeFoodsProductAddress(page.url);
  const { document } = parseHTML(page.html);
  const title = document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim();
  if (!title) {
    throw wholeFoodsErrors.create("WHOLEFOODS.PRODUCT_UNVERIFIED", {
      details: { url: address.url },
    });
  }
  const text = pageText(page.html);
  assertStore(text, store);
  const block = blockAfterTitle(text, title);
  return {
    codec: "wholefoods-product/1",
    asin: address.listingId,
    url: address.url,
    title,
    price: PRICE.exec(block)?.[0] ?? null,
    availability: UNAVAILABLE.test(block) ? "unavailable" : "available",
    storeId: store.storeId,
    storeLabel: store.label,
    capturedAt: page.capturedAt,
  };
}
