import { defineErrors } from "./define-errors.js";

/** Registered reasons retained in Reviews and source observations. */
export const listingErrors = defineErrors({
  "LISTING.IDENTITY_CONFLICT": { category: "SOURCE", message: "Identity conflict." },
  "LISTING.LIVE": { category: "SOURCE", message: "The listing was observed live at capture time." },
  "LISTING.NOT_FOUND": { category: "SOURCE", message: "Not found." },
  "LISTING.REDIRECTED_AWAY": { category: "SOURCE", message: "Redirected away." },
  "LISTING.REDIRECTED_TO_OTHER_PRODUCT": {
    category: "SOURCE",
    message: "Redirected to other product.",
  },
});
