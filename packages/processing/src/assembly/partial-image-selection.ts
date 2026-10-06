import { isCompleteLabelImage } from "@crawl-automation/v3-contracts";
import { assemblyErrors } from "./assembly-errors.js";
import type { MergePolicy } from "./merge-policy.js";
import { isPartialLabel, partialLabelConflicts } from "./partial-label.js";
import { fail, type MergeState, type LabelEvidence } from "./merge-state.js";

/** /6 applies the same readable-conflict guard to registered and reviewed incomplete images. */
export function selectPartialImage(
  state: MergeState,
  entry: LabelEvidence,
  policy: MergePolicy,
): boolean {
  if (
    !policy.sufficient ||
    !policy.completeLabel ||
    entry.kind !== "image" ||
    isCompleteLabelImage(entry)
  ) {
    return false;
  }
  if (!isPartialLabel(entry.candidate)) {
    return false;
  }
  const complete = policy.split ? [policy.split.complete] : policy.complete;
  const conflicts = complete.flatMap((full) =>
    partialLabelConflicts(entry.candidate, full.candidate, policy.split?.parts),
  );
  conflicts.forEach((code) => fail(state, entry.id, code));
  if (!conflicts.length) {
    state.warnings.push({
      id: entry.id,
      code: assemblyErrors.code("LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED"),
    });
  }
  return true;
}
