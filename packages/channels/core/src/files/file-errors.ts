import { artifactErrors, defineErrors } from "@crawl-automation/platform";

/** Stable acquisition codes, also used by retained completions and passive Reviews. */
export const fileErrors = defineErrors({
  ...artifactErrors.codes,
  "ARTIFACT.DIMENSIONS": { category: "ARTIFACT", message: "ARTIFACT.DIMENSIONS" },
  "SOURCE.ORIGIN_BLOCKED": { category: "SOURCE", message: "SOURCE.ORIGIN_BLOCKED" },
  "SOURCE.SSRF_BLOCKED": { category: "SOURCE", message: "SOURCE.SSRF_BLOCKED" },
  "SOURCE.NETWORK_UNAVAILABLE": { category: "SOURCE", message: "SOURCE.NETWORK_UNAVAILABLE" },
  "SOURCE.REDIRECT_LIMIT": { category: "SOURCE", message: "SOURCE.REDIRECT_LIMIT" },
  "SOURCE.HTTP_STATUS": { category: "SOURCE", message: "SOURCE.HTTP_STATUS" },
  "SOURCE.ENCODING": { category: "SOURCE", message: "SOURCE.ENCODING" },
  "SOURCE.SESSION_MISMATCH": { category: "SOURCE", message: "SOURCE.SESSION_MISMATCH" },
  "SOURCE.SESSION_UNAVAILABLE": { category: "SOURCE", message: "SOURCE.SESSION_UNAVAILABLE" },
  "INPUT.FINGERPRINT_MISMATCH": { category: "VALIDATION", message: "INPUT.FINGERPRINT_MISMATCH" },
  "RUNTIME.INCOMPATIBLE_CONSUMER": {
    category: "RUNTIME",
    message: "RUNTIME.INCOMPATIBLE_CONSUMER",
  },
  "ACQUIRE.EVIDENCE_CONFLICT": { category: "ARTIFACT", message: "ACQUIRE.EVIDENCE_CONFLICT" },
  "ACQUIRE.NOT_DURABLE": { category: "ARTIFACT", message: "ACQUIRE.NOT_DURABLE" },
  "ACQUIRE.OUTPUT_LIMIT": { category: "ARTIFACT", message: "ACQUIRE.OUTPUT_LIMIT" },
  "ACQUIRE.HANDOFF_UNVERIFIED": { category: "ARTIFACT", message: "ACQUIRE.HANDOFF_UNVERIFIED" },
  "ACQUIRE.HANDOFF_PENDING": { category: "ARTIFACT", message: "ACQUIRE.HANDOFF_PENDING" },
  "ACQUIRE.REVIEW_UNVERIFIED": { category: "ARTIFACT", message: "ACQUIRE.REVIEW_UNVERIFIED" },
  "ACQUIRE.INTENT_UNKNOWN": { category: "ARTIFACT", message: "ACQUIRE.INTENT_UNKNOWN" },
  "ACQUIRE.EXECUTION_UNKNOWN": { category: "ARTIFACT", message: "ACQUIRE.EXECUTION_UNKNOWN" },
  "ACQUIRE.UNRESOLVED": { category: "ARTIFACT", message: "ACQUIRE.UNRESOLVED" },
});
