import { defineErrors } from "../errors/define-errors.js";

/** Keep the retained-evidence codes stable for existing Review records and callers. */
export const artifactErrors = defineErrors({
  "ARTIFACT.MISSING": { category: "ARTIFACT", message: "ARTIFACT.MISSING" },
  "ARTIFACT.INTEGRITY": { category: "ARTIFACT", message: "ARTIFACT.INTEGRITY" },
  "ARTIFACT.MEDIA_TYPE": { category: "ARTIFACT", message: "ARTIFACT.MEDIA_TYPE" },
  "ARTIFACT.TOO_LARGE": { category: "ARTIFACT", message: "ARTIFACT.TOO_LARGE" },
  "ARTIFACT.UNAVAILABLE": { category: "ARTIFACT", message: "ARTIFACT.UNAVAILABLE" },
  "ARTIFACT.UPLOAD_UNKNOWN": { category: "ARTIFACT", message: "ARTIFACT.UPLOAD_UNKNOWN" },
  "ARTIFACT.KEY_CONFLICT": { category: "ARTIFACT", message: "ARTIFACT.KEY_CONFLICT" },
  "ARTIFACT.CACHE_UNAVAILABLE": { category: "ARTIFACT", message: "ARTIFACT.CACHE_UNAVAILABLE" },
  "ARTIFACT.SCOPE": { category: "VALIDATION", message: "ARTIFACT.SCOPE" },
});
