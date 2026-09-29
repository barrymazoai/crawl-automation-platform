import {
  LabelProductProvenanceSchema,
  type LabelCollectedProduct,
  type LabelProductManifest,
  type PackagingFacts,
} from "@crawl-automation/v3-contracts";
import { applyFailures, applyPackagingIssues, mergePolicy } from "./merge-policy.js";
import { selectLabel } from "./merge-selection.js";
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
) {
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
  return mergedLabel(state, provenance);
}

function mergedLabel(state: MergeState, provenance: Provenance[]) {
  const { manifest, packaging, formula } = state;
  const ingredients = labelIngredients(state);
  finalChecks(state, ingredients.length);
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
function finalChecks(state: MergeState, ingredientCount: number): void {
  const { formula } = state;
  if (!formula) {
    state.codes.add("VALIDATION.FORMULA_MISSING");
  }
  if (!ingredientCount) {
    state.codes.add("VALIDATION.INGREDIENTS_MISSING");
  }
  if (!state.packaging || state.counts.size <= 1) {
    return;
  }
  if (formula) {
    formula.servingsPerContainer = null;
  }
  const code = "PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT";
  if (!state.warnings.some((warning) => warning.code === code)) {
    state.warnings.push({ id: state.manifest.operationId, code });
  }
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
