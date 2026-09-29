import { defineErrors } from "@crawl-automation/platform";

/** Errors raised by the application services. */
export const appErrors = defineErrors({
  "RUN.NOT_FOUND": { category: "VALIDATION", message: "Run not found." },
  "RUN.SOURCE_NOT_FOUND": { category: "VALIDATION", message: "Brand source not found." },
  "RUN.SOURCE_DISABLED": { category: "VALIDATION", message: "Enable the source before a run." },
  "RUN.SOURCE_BUSY": { category: "VALIDATION", message: "This source already has an active run." },
  "RUN.REVISION_CONFLICT": { category: "VALIDATION", message: "Source changed; reload it first." },
  "RUN.STILL_RUNNING": {
    category: "VALIDATION",
    message: "The run still has running workflows; cancel it first.",
  },
  "RUN.RECENTLY_STOPPED": {
    category: "VALIDATION",
    message: "A workflow of this run stopped less than two minutes ago; settle it a little later.",
  },
  "REQUEST.ID_CONFLICT": {
    category: "VALIDATION",
    message: "This request ID was already used for a different request.",
  },
  "BRAND.NOT_FOUND": { category: "VALIDATION", message: "Brand not found." },
  "BRAND.SOURCE_NOT_FOUND": { category: "VALIDATION", message: "Source not found for this brand." },
  "BRAND.REVISION_CONFLICT": {
    category: "VALIDATION",
    message: "It changed meanwhile; reload it first.",
  },
  "BRAND.DUPLICATE": {
    category: "VALIDATION",
    message: "A brand or source like this already exists.",
  },
  "REVIEW.NOT_FOUND": { category: "VALIDATION", message: "Review not found." },
  "QUEUE.IMPORT_CONFLICT": {
    category: "VALIDATION",
    message: "A product in this list is already queued with different details.",
  },
  "QUEUE.CLEANUP_PENDING": {
    category: "VALIDATION",
    message: "A forced stop is still settling running products; resume once they have ended.",
  },
  "QUEUE.REQUEUE_NOT_SETTLED": {
    category: "VALIDATION",
    message: "Only completed or Review products can be queued again.",
  },
  "PERMIT.NOT_FOUND": { category: "VALIDATION", message: "Permit not found or already released." },
  "PERMIT.OWNER_RUNNING": {
    category: "VALIDATION",
    message: "The workflow holding this permit is still running.",
  },
  "PERMIT.OWNER_RECENTLY_STOPPED": {
    category: "VALIDATION",
    message: "The workflow holding this permit stopped less than two minutes ago.",
  },
  "DELIVERY.CHANNEL_NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "No workflow target is configured for this channel.",
  },
  "DELIVERY.CLUSTER_MISMATCH": {
    category: "RUNTIME",
    message: "A delivery target points at a different Temporal cluster.",
  },
});
