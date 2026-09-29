import { defineErrors } from "@crawl-automation/platform";

/** Errors raised when stored or remote state does not match what the application expects. */
export const storeErrors = defineErrors({
  "STORE.DELIVERY_GUARD_MISSING": {
    category: "IDENTITY",
    message: "The submission has no source guard; it cannot be started or closed.",
  },
  "STORE.DELIVERY_IDENTITY_CONFLICT": {
    category: "IDENTITY",
    message: "The stored delivery target or input differs from this request.",
  },
  "STORE.DELIVERY_INTENT_MISSING": {
    category: "IDENTITY",
    message: "No delivery intent exists for this submission.",
  },
  "STORE.RECEIPT_INCOMPLETE": {
    category: "IDENTITY",
    message: "An earlier request with this ID did not finish; use a new request ID.",
  },
  "STORE.UNEXPECTED_ROW": {
    category: "IDENTITY",
    message: "A stored row has an unexpected shape.",
  },
});
