import { assessLabelCandidate } from "@crawl-automation/v3-contracts";
import { assemblyErrors } from "./assembly-errors.js";
import type { MergePolicy } from "./merge-policy.js";
import { fail, type MergeState, type LabelEvidence } from "./merge-state.js";
import { applySourceReview } from "./source-without-label.js";
import { selectPartialImage } from "./partial-image-selection.js";
import { partialLabelCodes } from "./partial-label.js";

/** Apply quality and incomplete-source rules before any formula can be selected. */
export function reviewEntry(state: MergeState, entry: LabelEvidence, policy: MergePolicy): boolean {
  const integrity = policy.integrity(entry);
  if (integrity.length) {
    integrity.forEach((code) => {
      if (policy.textFallback && !policy.sufficient) {
        state.warnings.push({ id: entry.id, code });
      } else {
        fail(state, entry.id, code);
      }
    });
    return true;
  }
  if (selectPartialImage(state, entry, policy)) {
    return true;
  }
  const assessed = assessLabelCandidate(entry.candidate);
  for (const code of new Set(assessed.warnings.map((warning) => warning.code))) {
    state.warnings.push({ id: entry.id, code });
  }
  if (!policy.sufficient && policy.textFallback && entry.kind === "image") {
    legacyFallback(state, entry.id, assessed.codes);
    return true;
  }
  if (assessed.status === "review") {
    applySourceReview(state, { id: entry.id, codes: assessed.codes }, policy.completeLabel);
    return true;
  }
  return false;
}

/** Preserve /3–/5 text fallback semantics for historical results. */
function legacyFallback(state: MergeState, id: string, codes: string[]): void {
  if (codes.some((code) => !partialLabelCodes.includes(code))) {
    codes.forEach((code) => fail(state, id, code));
  } else {
    state.warnings.push({
      id,
      code: assemblyErrors.code("LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED"),
    });
  }
}
