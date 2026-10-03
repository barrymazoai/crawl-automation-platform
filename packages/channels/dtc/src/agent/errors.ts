import { defineErrors } from "@crawl-automation/platform";

export const dtcAgentErrors = defineErrors({
  "DTC.PRODUCT_SCOPE_UNRESOLVED": {
    category: "SOURCE",
    message: "The retained website evidence does not establish a single-product processing scope.",
  },
  "DTC.AGENT_REQUIRED": {
    category: "VALIDATION",
    message: "DTC requires its Codex/Ego native capture settings.",
  },
  "DTC.CAPTURE_REVIEW": {
    category: "SOURCE",
    message: "The capture agent retained incomplete or conflicting evidence.",
  },
  "DTC.CAPTURE_EVIDENCE": {
    category: "SOURCE",
    message: "The capture evidence failed host verification.",
  },
  "DTC.CAPTURE_PATH": {
    category: "ARTIFACT",
    message: "The capture path is outside its owned workspace or is not a regular file.",
  },
  "DTC.CAPTURE_LIMIT": {
    category: "ARTIFACT",
    message: "The retained capture exceeds its byte or file limit.",
  },
});
