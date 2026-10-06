import { assemblyErrors } from "./assembly-errors.js";
import {
  LabelProductProvenanceSchema,
  hasConfirmedNoOtherIngredients,
  isCompleteLabelImage,
  type LabelCollectedProduct,
  type LabelProductManifest,
  type PackagingFacts,
} from "@crawl-automation/v3-contracts";
import { applyFailures, applyPackagingIssues, mergePolicy } from "./merge-policy.js";
import { selectLabel } from "./merge-selection.js";
import { labelTypeOf } from "./label-type.js";
import { beginMerge, verifiedProvenance } from "./merge-sources.js";
import {
  byText,
  type MergeFailure,
  type MergeState,
  type Provenance,
  type VerifiedLabelSource,
} from "./merge-state.js";

export type { MergeFailure, VerifiedLabelSource } from "./merge-state.js";

/**
 * Merges a product's verified label sources into one label: no I/O. The readers must have re-verified the registered
 * original evidence; receipts alone are never trusted.
 */
export function mergeLabelProduct(
  manifest: LabelProductManifest,
  verified: { entries: VerifiedLabelSource[]; failures?: MergeFailure[] },
  packaging?: PackagingFacts,
): MergedLabel {
  const failures = verified.failures ?? [];
  const state = beginMerge(manifest, packaging);
  const { provenance, seen } = verifiedProvenance(state, verified.entries, failures);
  const policy = mergePolicy(state, provenance);
  applyFailures(state, failures, policy);
  applyPackagingIssues(state, policy);
  selectLabel(state, provenance, policy);
  if (seen.size !== state.sources.size) {
    state.codes.add("LABEL_PRODUCT.BARRIER_INCOMPLETE");
  }
  const merged = mergedLabel(state, provenance);
  return policy.onePart
    ? { ...merged, parts: partsRecord(state, { provenance, entries: verified.entries }) }
    : merged;
}

/** /7 results carry `parts`; older policies keep their exact assembly bytes. */
export type MergedLabel = ReturnType<typeof mergedLabel> & {
  parts?: ReturnType<typeof partsRecord>;
};

/**
 * collected-product/5 fields (owner 2026-10-06): which parts were found, the formula's printed panel, and the page
 * fragment behind every page-text source.
 */
function partsRecord(
  state: MergeState,
  sources: { provenance: Provenance[]; entries: VerifiedLabelSource[] },
) {
  const pageEvidence = sources.entries.flatMap((entry) =>
    entry.kind === "text" &&
    entry.evidence &&
    sources.provenance.some((kept) => kept.id === entry.id)
      ? [{ sourceId: entry.id, ...entry.evidence }]
      : [],
  );
  return {
    labelType: labelTypeOf(state.formula, sources),
    formulaFound: state.formula !== null,
    ingredientsFound: state.otherIngredients !== null || selectedAbsence(state, sources.provenance),
    pageEvidence: pageEvidence.sort((left, right) => byText(left.sourceId, right.sourceId)),
  };
}

function mergedLabel(state: MergeState, provenance: Provenance[]) {
  const { manifest, packaging, formula } = state;
  const ingredients = labelIngredients(state);
  finalChecks(state, ingredients.length > 0 || selectedAbsence(state, provenance));
  const comparison = manifest.admission?.comparison;
  const admission = {
    admissionPolicy: "label-packaging/1" as const,
    ...(comparison ? { comparisonPolicy: comparison } : {}),
    packaging,
  };
  const codec = packaging
    ? ("label-product-assembly/2" as const)
    : ("label-product-assembly/1" as const);
  const warnings = state.warnings.sort(
    (left, right) => byText(left.id, right.id) || byText(left.code, right.code),
  );
  return {
    codec,
    ...(manifest.evidencePolicy ? { evidencePolicy: manifest.evidencePolicy } : {}),
    ...(packaging ? admission : {}),
    status: state.codes.size ? ("review" as const) : ("ready" as const),
    codes: [...state.codes].sort(),
    warnings,
    formula,
    otherIngredients: state.otherIngredients,
    ingredients,
    provenance: provenance.map((entry) => LabelProductProvenanceSchema.parse(entry)),
  };
}

/** A label needs a formula and ingredients; packaging counts that disagree leave the count out, with a warning. */
function finalChecks(state: MergeState, ingredientsComplete: boolean): void {
  const { formula } = state;
  // /7 (owner 2026-10-06): one part is a product; only a label with neither part stays in Review.
  const onePart =
    state.manifest.evidencePolicy === "label-image-first/7" && (!!formula || ingredientsComplete);
  if (!formula) {
    addPartCode(state, onePart, "VALIDATION.FORMULA_MISSING");
  }
  if (!ingredientsComplete) {
    addPartCode(state, onePart, "VALIDATION.INGREDIENTS_MISSING");
  }
  if (!state.packaging || state.counts.size <= 1) {
    return;
  }
  if (formula) {
    formula.servingsPerContainer = null;
  }
  const code = assemblyErrors.code("PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT");
  if (!state.warnings.some((warning) => warning.code === code)) {
    state.warnings.push({ id: state.manifest.operationId, code });
  }
}

function addPartCode(
  state: MergeState,
  onePart: boolean,
  code: "VALIDATION.FORMULA_MISSING" | "VALIDATION.INGREDIENTS_MISSING",
): void {
  if (onePart) {
    state.warnings.push({ id: state.manifest.operationId, code: assemblyErrors.code(code) });
  } else {
    state.codes.add(assemblyErrors.code(code));
  }
}

/** Empty ingredients are justified by the same complete image that supplied the selected formula. */
function selectedAbsence(state: MergeState, provenance: Provenance[]): boolean {
  const sourceId = state.formula?.columns[0]?.rows[0]?.name.sourceId;
  return provenance.some(
    (entry) =>
      entry.id === sourceId &&
      isCompleteLabelImage(entry) &&
      hasConfirmedNoOtherIngredients(entry.candidate),
  );
}

/** Blend components from the formula, then the other ingredients, in printed order. */
function labelIngredients(state: MergeState): LabelCollectedProduct["ingredients"] {
  const components = (state.formula?.columns ?? []).flatMap((column, columnIndex) =>
    column.rows.flatMap((row, rowIndex) =>
      row.kind === "blend_component"
        ? [
            {
              name: row.name,
              role: "blend_component" as const,
              amount: row.amount,
              columnIndex,
              rowIndex,
              parentRowIndex: row.parentRowIndex,
            },
          ]
        : [],
    ),
  );
  const other = (state.otherIngredients?.items ?? []).map((name) => ({
    name,
    role: "other" as const,
    amount: null,
    columnIndex: null,
    rowIndex: null,
    parentRowIndex: null,
  }));
  return [...components, ...other];
}
