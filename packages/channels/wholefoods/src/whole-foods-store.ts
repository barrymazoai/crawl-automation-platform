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
  /** The postal code the site's store picker is searched with. */
  postalCode: z.string().regex(/^\d{5}$/),
});
export type WholeFoodsStore = z.infer<typeof WholeFoodsStoreSchema>;

/** Owner-selected store for all product captures and brand scans. */
export const WHOLE_FOODS_STORE: WholeFoodsStore = {
  storeId: "10259",
  label: "The Alameda",
  postalCode: "95126",
};

/** The store a page says it is priced for ("Pickup at The Alameda"); null when the page names none. */
export function shownStore(pageText: string): string | null {
  const match = /Pickup (?:at|from)\s*\n?\s*([^\n]+)/.exec(pageText);
  return match?.[1]?.trim() ?? null;
}

/** Refuses a page priced for any other store than the configured one. */
export function assertStore(pageText: string, store: WholeFoodsStore): void {
  const shown = shownStore(pageText);
  if (!shown) {
    throw wholeFoodsErrors.create("WHOLEFOODS.STORE_UNVERIFIED");
  }
  if (shown !== store.label) {
    throw wholeFoodsErrors.create("WHOLEFOODS.STORE_MISMATCH", {
      details: { shown, expected: store.label },
    });
  }
}
