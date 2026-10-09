import { defineErrors } from "@crawl-automation/platform";

export const brandEnrichmentErrors = defineErrors({
  "BRAND_ENRICHMENT.CLEANUP_PENDING": {
    category: "RUNTIME",
    message: "Exact DTC execution has not confirmed stopping.",
  },
  "BRAND_ENRICHMENT.NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "Brand enrichment is not configured.",
  },
  "BRAND_ENRICHMENT.NOT_WIRED": {
    category: "RUNTIME",
    message: "Brand enrichment task implementations are not wired.",
  },
  "BRAND_ENRICHMENT.NOT_FOUND": {
    category: "VALIDATION",
    message: "Brand enrichment record not found in the available records.",
  },
  "BRAND_ENRICHMENT.CLAIM_CONFLICT": {
    category: "VALIDATION",
    message: "Another worker claimed this request.",
  },
  "BRAND_ENRICHMENT.IDENTITY_UNRESOLVED": {
    category: "VALIDATION",
    message: "Company identity is ambiguous or conflicting.",
  },
  "BRAND_ENRICHMENT.INVALID_STATE": {
    category: "VALIDATION",
    message: "This operation is not allowed in the current state.",
  },
  "BRAND_ENRICHMENT.INVALID_MATCH": {
    category: "VALIDATION",
    message: "The proposed classification or match is not supported by its evidence.",
  },
  "BRAND_ENRICHMENT.PRODUCTS_TIMEOUT": {
    category: "RUNTIME",
    message: "The bounded wait for DTC products expired.",
  },
  "BRAND_ENRICHMENT.MERGE_NOT_WIRED": {
    category: "RUNTIME",
    message: "The company merge port is unavailable; the question remains open.",
  },
});
