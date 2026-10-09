import { defineErrors } from "@crawl-automation/platform";

export const productDeliveryErrors = defineErrors({
  "PRODUCT_DELIVERY.MATERIAL_MISSING": {
    category: "VALIDATION",
    message: "The settled product has no complete retained delivery material.",
  },
  "PRODUCT_DELIVERY.INTEGRITY": {
    category: "VALIDATION",
    message: "Retained delivery material does not match its hash or SKU owner.",
  },
  "PRODUCT_DELIVERY.LABEL_UNSUPPORTED": {
    category: "VALIDATION",
    message: "The full label cannot be represented losslessly by Supply Smart's label contract.",
  },
  "PRODUCT_DELIVERY.ANSWER_MISMATCH": {
    category: "RUNTIME",
    message: "Supply Smart returned an unexpected run or item ledger.",
  },
  "PRODUCT_DELIVERY.VERIFY_FAILED": {
    category: "RUNTIME",
    message: "Supply Smart did not verify the observation.",
  },
  "PRODUCT_DELIVERY.LABEL_VERIFY_FAILED": {
    category: "RUNTIME",
    message: "Supply Smart did not return the complete submitted label.",
  },
  "PRODUCT_DELIVERY.COMPLETE_FAILED": {
    category: "RUNTIME",
    message: "Supply Smart did not confirm full-run completion.",
  },
});
