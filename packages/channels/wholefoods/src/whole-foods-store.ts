import { z } from "zod";
import { wholeFoodsErrors } from "./whole-foods-errors.js";

/**
 * The one store every Whole Foods page is read for (owner decision 2026-09-28: The Alameda, San Jose, store ID
 * 10259). Prices and availability differ by store, so every metrics row records this ID. Comes from config.
 */
export const WholeFoodsStoreSchema = z.strictObject({
  storeId: z.string().regex(/^\d{1,12}$/),
  /** The name the site shows for the store, e.g. `The Alameda`. */
  label: z.string().min(1).max(200),
  /** The store's postal code, sent with the store in the store cookie. */
  postalCode: z.string().regex(/^\d{5}$/),
});
export type WholeFoodsStore = z.infer<typeof WholeFoodsStoreSchema>;

/** Owner-selected store for all product captures and brand scans. */
export const WHOLE_FOODS_STORE: WholeFoodsStore = {
  storeId: "10259",
  label: "The Alameda",
  postalCode: "95126",
};

/**
 * The cookie the site reads the shopper's store from: base64 JSON with the store ID and delivery ZIP. Checked
 * 2026-10-01 with plain requests: without it, or with a bare ID, the site prices every page for Lamar (10145).
 */
export function wholeFoodsStoreCookie(store: WholeFoodsStore): string {
  const value = btoa(JSON.stringify({ id: store.storeId, deliveryZip: store.postalCode }));
  return `wfm_store_d8=${value}`;
}

// The page data's store preference (`"storePreference":{"buid":"10259","storeAcronym":"ALM","storeName":…`),
// in plain or JSON-escaped script text. The 2026-10 site no longer prints "Pickup at <store>".
const quote = String.raw`\\?"`;
const field = (name: string, value: string) =>
  String.raw`${quote}${name}${quote}\s*:\s*${quote}${value}${quote}`;
export const STORE_PREFERENCE = new RegExp(
  String.raw`${quote}storePreference${quote}\s*:\s*\{\s*` +
    field("buid", String.raw`(\d+)`) +
    String.raw`(?:\s*,\s*` +
    field("storeAcronym", String.raw`[^"\\]*`) +
    String.raw`)?\s*,\s*` +
    field("storeName", String.raw`([^"\\]*)`),
);

/** The store a page is priced for, from its page data; null when the page names none. */
export function shownStore(html: string): { storeId: string; name: string } | null {
  const match = STORE_PREFERENCE.exec(html);
  return match?.[1] ? { storeId: match[1], name: match[2] ?? "" } : null;
}

/** Refuses a page priced for any other store than the configured one. */
export function assertStore(html: string, store: WholeFoodsStore): void {
  const shown = shownStore(html);
  if (!shown) {
    throw wholeFoodsErrors.create("WHOLEFOODS.STORE_UNVERIFIED");
  }
  if (shown.storeId !== store.storeId) {
    throw wholeFoodsErrors.create("WHOLEFOODS.STORE_MISMATCH", {
      details: { shown: `${shown.name} (${shown.storeId})`, expected: store.storeId },
    });
  }
}
