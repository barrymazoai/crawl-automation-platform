import { isPartialLabel, partialLabelConflicts } from "./partial-label.js";
import { assemblyErrors } from "./assembly-errors.js";
import {
  isCompleteLabelImage,
  isCompleteLabelText,
  isOrderedEvidencePolicy,
  labelImageIntegrityCodes,
  labelNumericSourceConflict,
} from "@crawl-automation/v3-contracts";
import type { MergeFailure, MergeState, LabelEvidence } from "./merge-state.js";
import { applySourceReview, SOURCE_WITHOUT_LABEL } from "./source-without-label.js";
import { splitLabel } from "./split-label.js";
import { unusedPartSource } from "./one-part-source.js";

/** What the manifest's evidence policy decides for this set of verified sources. */
export interface MergePolicy {
  /** `label-image-first/4` and `/5`: image integrity problems keep an image out. */
  quality: boolean;
  /** A complete, intact image is present and takes priority over text. */
  imageFirst: boolean;
  /** No complete image, but a complete text: the text is used and images only warn. */
  textFallback: boolean;
  /** A complete, eligible label is available, independently of image-first policy. */
  completeLabel: boolean;
  /** /6 and /7: compare incomplete siblings with every eligible complete label. */
  sufficient: boolean;
  /** /7 (owner 2026-10-06): a formula or ingredients alone is a label; unused partial sources only warn. */
  onePart: boolean;
  complete: LabelEvidence[];
  /** Whole printed sections establish coverage; selectLabel still selects and compares fields. */
  split: ReturnType<typeof splitLabel>;
  integrity(entry: LabelEvidence): string[];
}

const FROM_2 = [
  "label-image-first/2",
  "label-image-first/3",
  "label-image-first/4",
  "label-image-first/5",
];
const FROM_3 = [
  "label-image-first/3",
  "label-image-first/4",
  "label-image-first/5",
  "label-image-first/6",
  "label-image-first/7",
];
const SECONDARY_TEXT =
  /^TEXT\.LABEL_(?:GROUP_EMPTY|GROUP_INVALID|ROW_ORDER_INVALID|COVERAGE_UNCERTAIN|EXTRACTION_INCOMPLETE|FORMULA_INCOMPLETE|INGREDIENTS_INCOMPLETE|INVALID_OUTPUT|INGREDIENT_BOUNDARY)$/;
const TEXT_QUALITY =
  /^TEXT\.(?:LABEL_[A-Z_]+|CITATION_INVALID|COVERAGE_UNCERTAIN|EXTRACTION_INCOMPLETE)$/;
const PARTIAL_IMAGE =
  /^VISION\.LABEL_(?:INGREDIENTS_INCOMPLETE|FORMULA_INCOMPLETE|AMOUNT_UNREADABLE|CORE_MISSING|EVIDENCE_UNCERTAIN)$/;
const QUALITY_IMAGE = /^VISION\.LABEL_(?:AMOUNT_EVIDENCE_CONFLICT|INGREDIENT_BOUNDARY)$/;

export function mergePolicy(state: MergeState, provenance: LabelEvidence[]): MergePolicy {
  const policy = state.manifest.evidencePolicy ?? "";
  const { ordered, onePart, quality } = policyFlags(policy);
  const integrity = (entry: LabelEvidence) =>
    quality && entry.kind === "image" ? labelImageIntegrityCodes(entry.candidate) : [];
  const eligible = provenance.filter((entry) => !integrity(entry).length);
  const complete = eligible.filter(
    (entry) => isCompleteLabelImage(entry) || isCompleteLabelText(entry),
  );
  const split = ordered && !complete.length ? splitLabel(eligible, onePart) : null;
  const completeLabel = !!split || complete.length > 0;
  const imageFirst = !!policy && eligible.some(isCompleteLabelImage);
  const textFallback = FROM_3.includes(policy) && !imageFirst && eligible.some(isCompleteLabelText);
  if (numericConflict(policy, eligible)) {
    state.codes.add(assemblyErrors.code("LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT"));
  }
  if (textFallback) {
    state.warnings.push({
      id: state.manifest.operationId,
      code: assemblyErrors.code("LABEL_PRODUCT.COMPLETE_TEXT_FALLBACK"),
    });
  }
  return {
    quality,
    imageFirst,
    textFallback,
    completeLabel,
    integrity,
    complete,
    split,
    sufficient: ordered,
    onePart,
  };
}

function policyFlags(policy: string) {
  const ordered = isOrderedEvidencePolicy(policy);
  return {
    ordered,
    onePart: policy === "label-image-first/7",
    quality: ordered || ["label-image-first/4", "label-image-first/5"].includes(policy),
  };
}

function numericConflict(policy: string, eligible: LabelEvidence[]) {
  return policy === "label-image-first/4" && labelNumericSourceConflict(eligible);
}

/**
 * An absent text label only warns beside a complete label. From `/2`, a verified, executed text
 * quality Review warns when a complete image carries the label; with a text fallback, a verified
 * partial-image Review only warns. Unknown execution, missing receipts and identity failures block.
 */
export function applyFailures(
  state: MergeState,
  failures: MergeFailure[],
  policy: MergePolicy,
): void {
  for (const failure of failures) {
    // /6 can replace a rejected, partial page reading with complete image panels. Its unverified
    // text never contributes fields. Other formula-bearing coverage failures remain blocking.
    if (
      partialTextFallback(failure, policy) ||
      imageReplacesText(state, failure, policy) ||
      unusedPartSource(state, failure, policy) ||
      (failure.hasFormula === undefined && excused(state, failure, policy))
    ) {
      state.warnings.push({ id: failure.id, code: failure.code });
    } else {
      applySourceReview(
        state,
        { id: failure.id, codes: [failure.code], withoutLabel: failure.hasFormula === false },
        policy.completeLabel && failure.verifiedExecuted === true,
      );
    }
  }
}

/**
 * Owner 2026-10-05: under /6 a failed page-text reading yields to a complete image label. The failed text
 * never contributes fields; identity, receipt and conflict failures are not label-quality codes and still block.
 */
function imageReplacesText(state: MergeState, failure: MergeFailure, policy: MergePolicy): boolean {
  return (
    isOrderedEvidencePolicy(state.manifest.evidencePolicy) &&
    policy.imageFirst &&
    failure.verifiedExecuted === true &&
    // A text Review proven to hold no formula keeps its existing "source without label" warning path.
    failure.hasFormula !== false &&
    state.sources.get(failure.id)?.kind === "text" &&
    // Text that holds no label keeps the existing "source without label" warning path.
    !SOURCE_WITHOUT_LABEL.includes(failure.code) &&
    TEXT_QUALITY.test(failure.code)
  );
}

function partialTextFallback(failure: MergeFailure, policy: MergePolicy): boolean {
  return (
    !!policy.split?.images && failure.verifiedExecuted === true && failure.incompleteText === true
  );
}

/** Whether a verified, executed failure only warns under this policy. */
function excused(state: MergeState, failure: MergeFailure, policy: MergePolicy): boolean {
  if (failure.verifiedExecuted !== true) {
    return false;
  }
  const kind = state.sources.get(failure.id)?.kind;
  if (kind === "text") {
    return secondaryTextExcused(state.manifest.evidencePolicy ?? "", failure.code, policy);
  }
  return kind === "image" && partialImageExcused(state, failure, policy);
}

/** From `/2`, a text quality failure beside a complete image (from `/5`, also a citation failure). */
function secondaryTextExcused(evidencePolicy: string, code: string, policy: MergePolicy): boolean {
  const citation = evidencePolicy === "label-image-first/5" && code === "TEXT.CITATION_INVALID";
  return (
    FROM_2.includes(evidencePolicy) && policy.imageFirst && (citation || SECONDARY_TEXT.test(code))
  );
}

/** /6 requires a complete label plus a compatible saved answer; older fallback rules stay frozen. */
function partialImageExcused(
  state: MergeState,
  failure: MergeFailure,
  policy: MergePolicy,
): boolean {
  if (policy.sufficient) {
    return compatiblePartial(state, failure, policy);
  }
  const quality = policy.quality && QUALITY_IMAGE.test(failure.code);
  return policy.textFallback && (PARTIAL_IMAGE.test(failure.code) || quality);
}

function compatiblePartial(state: MergeState, failure: MergeFailure, policy: MergePolicy) {
  const candidate = failure.candidate;
  if (
    !policy.completeLabel ||
    !candidate ||
    !PARTIAL_IMAGE.test(failure.code) ||
    !isPartialLabel(candidate) ||
    labelImageIntegrityCodes(candidate).length > 0
  ) {
    return false;
  }
  const complete = policy.split ? [policy.split.complete] : policy.complete;
  const parts = policy.split?.parts;
  const conflicts = complete.flatMap((entry) =>
    partialLabelConflicts(candidate, entry.candidate, parts),
  );
  conflicts.forEach((code) => state.codes.add(code));
  return conflicts.length === 0;
}

/** Packaging problems only warn when a complete image carries the label. */
export function applyPackagingIssues(state: MergeState, policy: MergePolicy): void {
  for (const code of state.packaging?.blockingIssues ?? []) {
    if (policy.imageFirst) {
      state.warnings.push({ id: state.manifest.operationId, code });
    } else {
      state.codes.add(code);
    }
  }
}
