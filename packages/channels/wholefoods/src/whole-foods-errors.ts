import { defineErrors } from "@crawl-automation/platform";

const source = (message: string) => ({ category: "SOURCE" as const, message });

/** Errors of reading Whole Foods pages. */
export const wholeFoodsErrors = defineErrors({
  "WHOLEFOODS.SEARCH_THROTTLED": source(
    "The brand search and canary could not establish a trustworthy result at this store.",
  ),
  "WHOLEFOODS.URL": source("The address is not a Whole Foods product or brand search page."),
  "WHOLEFOODS.PRODUCT_UNVERIFIED": source("The page does not show one readable product."),
  "WHOLEFOODS.STORE_UNVERIFIED": source("The page does not show which store it is priced for."),
  "WHOLEFOODS.STORE_MISMATCH": source(
    "The page is priced for another store than the configured one.",
  ),
  "WHOLEFOODS.STORE_NOT_SET": source("The browser could not be set to the configured store."),
  "WHOLEFOODS.LISTING_UNVERIFIED": source(
    "The search page showed neither products nor a no-results notice.",
  ),
});

export type WholeFoodsErrorCode = keyof typeof wholeFoodsErrors.codes;
