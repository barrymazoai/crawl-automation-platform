import { labelValidationErrors } from "../label/validation-errors.js";
import { assemblyErrors } from "./assembly-errors.js";
import { isDeepStrictEqual } from "node:util";
import {
  assessLabelCandidate,
  isCompleteLabelImage,
  labelFormulaStructure,
  labelNameForComparison,
  labelTypographyStructure,
  projectLabelProductCandidate,
} from "@crawl-automation/v3-contracts";
import type { MergePolicy } from "./merge-policy.js";
import { byText, fail, words, type MergeState, type Provenance } from "./merge-state.js";

type Candidate = Provenance["candidate"];
type Projected = ReturnType<typeof projectLabelProductCandidate>;

const PARTIAL_LABEL: readonly string[] = [
  labelValidationErrors.code("LABEL.INGREDIENTS_INCOMPLETE"),
  labelValidationErrors.code("LABEL.FORMULA_INCOMPLETE"),
  labelValidationErrors.code("LABEL.AMOUNT_UNREADABLE"),
  labelValidationErrors.code("LABEL.CORE_MISSING"),
  labelValidationErrors.code("LABEL.EVIDENCE_UNCERTAIN"),
];

/**
 * Picks the formula and the other ingredients: a complete image first, then images, then text when an image leads;
 * otherwise by source ID. Every later source must agree with what was picked, or the conflict is recorded.
 */
export function selectLabel(
  state: MergeState,
  provenance: Provenance[],
  policy: MergePolicy,
): void {
  const priority = (entry: Provenance) => {
    if (!policy.imageFirst || isCompleteLabelImage(entry)) {
      return 0;
    }
    return entry.kind === "image" ? 1 : 2;
  };
  const ordered = [...provenance].sort(
    (left, right) => priority(left) - priority(right) || byText(left.id, right.id),
  );
  for (const entry of ordered) {
    selectEntry(state, entry, policy);
  }
}

function selectEntry(state: MergeState, entry: Provenance, policy: MergePolicy): void {
  const integrityCodes = policy.integrity(entry);
  if (integrityCodes.length) {
    for (const code of integrityCodes) {
      if (policy.textFallback) {
        state.warnings.push({ id: entry.id, code });
      } else {
        fail(state, entry.id, code);
      }
    }
    return;
  }
  const candidate = entry.candidate;
  const assessed = assessLabelCandidate(candidate);
  if (policy.textFallback && entry.kind === "image") {
    // Keep the original partial evidence; never mix unreadable image rows into the complete text label.
    if (assessed.codes.some((code) => !PARTIAL_LABEL.includes(code))) {
      assessed.codes.forEach((code) => fail(state, entry.id, code));
    } else {
      state.warnings.push({
        id: entry.id,
        code: assemblyErrors.code("LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED"),
      });
    }
    return;
  }
  if (assessed.status === "review") {
    assessed.codes.forEach((code) => fail(state, entry.id, code));
    return;
  }
  const projected = projectLabelProductCandidate(entry.id, candidate);
  const secondaryText = policy.imageFirst && entry.kind === "text";
  const pick = { entry, candidate, projected, secondaryText, imageFirst: policy.imageFirst };
  selectFormula(state, pick);
  selectOtherIngredients(state, pick);
}

interface Pick {
  entry: Provenance;
  candidate: Candidate;
  projected: Projected;
  secondaryText: boolean;
  /** A complete image leads this product: packaging serving-size conflicts only warn. */
  imageFirst: boolean;
}

function selectFormula(state: MergeState, pick: Pick): void {
  const { entry, candidate, projected, secondaryText } = pick;
  if (!candidate.formula) {
    return;
  }
  const comparison = state.manifest.admission?.comparison;
  const shape = comparison
    ? labelTypographyStructure(candidate, comparison)
    : labelFormulaStructure(candidate);
  if (!shape) {
    return;
  }
  checkAgainstPackaging(state, shape, pick);
  if (state.formulaShape && !isDeepStrictEqual(state.formulaShape, shape)) {
    if (secondaryText) {
      state.warnings.push({
        id: entry.id,
        code: assemblyErrors.code("LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT"),
      });
    } else {
      state.codes.add(assemblyErrors.code("LABEL_PRODUCT.FORMULA_CONFLICT"));
    }
  }
  if (!state.formula && !secondaryText) {
    state.formulaShape = shape;
    state.formula = projected.formula;
  }
}

type Shape = NonNullable<ReturnType<typeof labelFormulaStructure>>;

/**
 * With packaging evidence, the container count is compared across sources but never kept as a per-serving value (the
 * original stays in the provenance), and the serving size must match the page's.
 */
function checkAgainstPackaging(state: MergeState, shape: Shape, pick: Pick): void {
  const { packaging } = state;
  if (!packaging) {
    return;
  }
  if (shape.servingsPerContainer) {
    state.counts.add(shape.servingsPerContainer);
  }
  shape.servingsPerContainer = null;
  const servingSize = packaging.servingSize.value;
  if (!servingSize || shape.servingSize === words(servingSize)) {
    return;
  }
  if (pick.imageFirst) {
    state.warnings.push({
      id: pick.entry.id,
      code: assemblyErrors.code("PACKAGING.SERVING_SIZE_CONFLICT"),
    });
  } else {
    state.codes.add(assemblyErrors.code("PACKAGING.SERVING_SIZE_CONFLICT"));
  }
}

function selectOtherIngredients(state: MergeState, pick: Pick): void {
  const { entry, candidate, projected, secondaryText } = pick;
  if (!candidate.otherIngredients) {
    return;
  }
  const comparison = state.manifest.admission?.comparison;
  const shape = candidate.otherIngredients.items.map((item) =>
    comparison ? labelNameForComparison(item.text) : words(item.text),
  );
  if ((state.otherShape || secondaryText) && !isDeepStrictEqual(state.otherShape, shape)) {
    if (secondaryText) {
      state.warnings.push({
        id: entry.id,
        code: assemblyErrors.code("LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT"),
      });
    } else {
      state.codes.add(assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT"));
    }
  }
  if (!state.otherIngredients && !secondaryText) {
    state.otherShape = shape;
    state.otherIngredients = projected.otherIngredients;
  }
}
