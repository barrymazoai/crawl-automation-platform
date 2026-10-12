import { defineErrors } from "@crawl-automation/platform";

export const brandCompanyErrors = defineErrors({
  "PRODUCT_SYNC.NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "Supply Smart company matching is not configured.",
  },
  "PRODUCT_SYNC.INVALID_COMPANY": {
    category: "INGEST",
    message: "Supply Smart returned inconsistent company identity.",
  },
});
