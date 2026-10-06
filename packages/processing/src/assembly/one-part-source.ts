import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import type { LabelEvidence, MergeFailure, MergeState } from "./merge-state.js";
import type { LabelParts } from "./split-label.js";

/** The merge-policy facts this rule reads (kept structural so the policy module can depend on it). */
interface OnePartPolicy {
  onePart: boolean;
  completeLabel: boolean;
  split: { complete: LabelEvidence; parts: LabelParts } | null;
}
import { partialLabelConflicts } from "./partial-label.js";
import { SOURCE_WITHOUT_LABEL } from "./source-without-label.js";

const LABEL_QUALITY = /^(?:VISION\.LABEL_[A-Z_]+|TEXT\.LABEL_[A-Z_]+|TEXT\.CITATION_INVALID)$/;

/**
 * /7: beside a selected formula or ingredient list, a verified source that ended in a label-quality Review only warns,
 * unless its readable answer contradicts the selected parts. Unknown execution and identity failures still block.
 */
export function unusedPartSource(
  state: MergeState,
  failure: MergeFailure,
  policy: OnePartPolicy,
): boolean {
  if (
    !policy.onePart ||
    !policy.completeLabel ||
    failure.verifiedExecuted !== true ||
    // A text Review proven to hold no label keeps its "source without label" warnings.
    failure.hasFormula === false ||
    SOURCE_WITHOUT_LABEL.includes(failure.code) ||
    !LABEL_QUALITY.test(failure.code)
  ) {
    return false;
  }
  const selected = policy.split ? [policy.split] : [];
  const conflicts = failure.candidate
    ? selected.flatMap((split) =>
        partialLabelConflicts(
          failure.candidate as LabelImageCandidate,
          split.complete.candidate,
          split.parts,
        ),
      )
    : [];
  conflicts.forEach((code) => state.codes.add(code));
  return conflicts.length === 0;
}
