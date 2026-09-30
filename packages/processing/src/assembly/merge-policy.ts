import { assemblyErrors } from "./assembly-errors.js";
import {
  isCompleteLabelImage,
  isCompleteLabelText,
  labelImageIntegrityCodes,
  labelNumericSourceConflict,
} from "@crawl-automation/v3-contracts";
import type { MergeFailure, MergeState, Provenance } from "./merge-state.js";
import { applySourceReview } from "./source-without-label.js";

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
  integrity(entry: Provenance): string[];
}

const FROM_2 = [
  "label-image-first/2",
  "label-image-first/3",
  "label-image-first/4",
  "label-image-first/5",
];
const FROM_3 = ["label-image-first/3", "label-image-first/4", "label-image-first/5"];
const SECONDARY_TEXT =
  /^TEXT\.LABEL_(?:GROUP_EMPTY|GROUP_INVALID|ROW_ORDER_INVALID|COVERAGE_UNCERTAIN|EXTRACTION_INCOMPLETE|FORMULA_INCOMPLETE|INGREDIENTS_INCOMPLETE|INVALID_OUTPUT|INGREDIENT_BOUNDARY)$/;
const PARTIAL_IMAGE =
  /^VISION\.LABEL_(?:INGREDIENTS_INCOMPLETE|FORMULA_INCOMPLETE|AMOUNT_UNREADABLE|CORE_MISSING|EVIDENCE_UNCERTAIN)$/;
const QUALITY_IMAGE = /^VISION\.LABEL_(?:AMOUNT_EVIDENCE_CONFLICT|INGREDIENT_BOUNDARY)$/;

export function mergePolicy(state: MergeState, provenance: Provenance[]): MergePolicy {
  const policy = state.manifest.evidencePolicy ?? "";
  const quality = ["label-image-first/4", "label-image-first/5"].includes(policy);
  const integrity = (entry: Provenance) =>
    quality && entry.kind === "image" ? labelImageIntegrityCodes(entry.candidate) : [];
  const eligible = provenance.filter((entry) => !integrity(entry).length);
  const completeLabel = eligible.some(isCompleteLabelImage) || eligible.some(isCompleteLabelText);
  const imageFirst = !!state.manifest.evidencePolicy && eligible.some(isCompleteLabelImage);
  const textFallback = FROM_3.includes(policy) && !imageFirst && eligible.some(isCompleteLabelText);
  if (policy === "label-image-first/4" && labelNumericSourceConflict(eligible)) {
    state.codes.add(assemblyErrors.code("LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT"));
  }
  if (textFallback) {
    state.warnings.push({
      id: state.manifest.operationId,
      code: assemblyErrors.code("LABEL_PRODUCT.COMPLETE_TEXT_FALLBACK"),
    });
  }
  return { quality, imageFirst, textFallback, completeLabel, integrity };
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
    if (excused(state, failure, policy)) {
      state.warnings.push({ id: failure.id, code: failure.code });
    } else {
      applySourceReview(
        state,
        { id: failure.id, codes: [failure.code] },
        policy.completeLabel && failure.verifiedExecuted === true,
      );
    }
  }
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
  return kind === "image" && partialImageExcused(failure.code, policy);
}

/** From `/2`, a text quality failure beside a complete image (from `/5`, also a citation failure). */
function secondaryTextExcused(evidencePolicy: string, code: string, policy: MergePolicy): boolean {
  const citation = evidencePolicy === "label-image-first/5" && code === "TEXT.CITATION_INVALID";
  return (
    FROM_2.includes(evidencePolicy) && policy.imageFirst && (citation || SECONDARY_TEXT.test(code))
  );
}

/** With a complete text fallback, a partial-image failure (under `/4`+, also an image-quality failure). */
function partialImageExcused(code: string, policy: MergePolicy): boolean {
  const quality = policy.quality && QUALITY_IMAGE.test(code);
  return policy.textFallback && (PARTIAL_IMAGE.test(code) || quality);
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
