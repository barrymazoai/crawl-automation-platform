import { defineErrors } from "./define-errors.js";

export const resourceHealthErrors = defineErrors({
  "RESOURCE_HEALTH.PROBE_FAILED": {
    category: "RUNTIME",
    message: "A resource health probe failed; this resource is unhealthy.",
  },
  "RESOURCE_HEALTH.WRITE_FAILED": {
    category: "RUNTIME",
    message: "Resource health could not be written; its previous health will expire.",
  },
  "RESOURCE_HEALTH.CONTROLLER_MISMATCH": {
    category: "VALIDATION",
    message: "No resource row matches the configured resource ID and controller.",
  },
});
