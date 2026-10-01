import { defineErrors } from "@crawl-automation/platform";

const source = (message: string) => ({ category: "SOURCE" as const, message });
export const costcoErrors = defineErrors({
  "COSTCO.URL": source("The address is not a Costco product or category-filtered brand page."),
  "COSTCO.IDENTITY_UNVERIFIED": source("The page does not establish one online product identity."),
  "COSTCO.PRODUCT_UNVERIFIED": source("The page does not show a readable product."),
  "COSTCO.STORE_UNVERIFIED": source("The brand page does not show its warehouse."),
  "COSTCO.STORE_MISMATCH": source("The shown warehouse differs from the configured warehouse."),
  "COSTCO.LISTING_UNVERIFIED": source("The drawn page shows neither product tiles nor no results."),
  "COSTCO.SEARCH_THROTTLED": source("The empty brand search could not be verified by its canary."),
  "COSTCO.PROJECTION_CONFLICT": source(
    "The retained product projection belongs to another listing.",
  ),
});
