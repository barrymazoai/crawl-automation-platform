import type { ListingEvidence, ListingSightingInput, UnlistedReasonName } from "./listing-model.js";

/** The evidence each unlisted reason must carry, so every unlisted sighting says exactly why. */
const REQUIRED_EVIDENCE: Record<UnlistedReasonName, readonly (keyof ListingEvidence)[]> = {
  not_found: ["httpStatus"],
  redirected_to_other_product: ["observedExternalId", "finalUrl"],
  redirected_away: ["finalUrl"],
  identity_conflict: ["observedExternalId"],
};

/**
 * What a sighting lacks: an unlisted sighting needs a reason and that reason's evidence; a live one has no reason.
 * Empty when the sighting is complete.
 */
export function missingEvidence(sighting: ListingSightingInput): string[] {
  if (sighting.state === "live") {
    return sighting.reason === null ? [] : ["no reason for a live listing"];
  }
  if (!sighting.reason) {
    return ["reason"];
  }
  return REQUIRED_EVIDENCE[sighting.reason].filter((field) => sighting.evidence[field] === null);
}
