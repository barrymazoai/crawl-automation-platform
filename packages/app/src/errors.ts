import { defineErrors } from "@crawl-automation/platform";

/** Errors raised by the application services. */
export const appErrors = defineErrors({
  "RUN.NOT_FOUND": { category: "VALIDATION", message: "Run not found." },
  "RUN.SOURCE_NOT_FOUND": { category: "VALIDATION", message: "Brand source not found." },
  "RUN.SOURCE_DISABLED": { category: "VALIDATION", message: "Enable the source before a run." },
  "RUN.SOURCE_BUSY": { category: "VALIDATION", message: "This source already has an active run." },
  "RUN.REVISION_CONFLICT": { category: "VALIDATION", message: "Source changed; reload it first." },
  "RUN.REQUEST_ID_CONFLICT": {
    category: "VALIDATION",
    message: "This request ID was already used for a different run.",
  },
  "RUN.STILL_RUNNING": {
    category: "VALIDATION",
    message: "The run still has running workflows; cancel it first.",
  },
  "RUN.RECENTLY_STOPPED": {
    category: "VALIDATION",
    message: "A workflow of this run stopped less than two minutes ago; settle it a little later.",
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
