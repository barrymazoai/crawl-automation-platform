import type { labelAgreementFormula } from "@crawl-automation/v3-contracts";
import { assemblyErrors } from "./assembly-errors.js";
import type { MergeState } from "./merge-state.js";
import { sameServingSize } from "./serving-size.js";

export type Shape = NonNullable<ReturnType<typeof labelAgreementFormula>>;

/**
 * With packaging evidence, the container count is compared across sources but never kept as a per-serving value (the
 * original stays in the provenance), and the serving size must match the page's.
 */
export function checkAgainstPackaging(
  state: MergeState,
  shape: Shape,
  pick: { imageFirst: boolean; entry: { id: string } },
): void {
  const { packaging } = state;
  if (!packaging) {
    return;
  }
  if (shape.servingsPerContainer) {
    state.counts.add(shape.servingsPerContainer);
  }
  shape.servingsPerContainer = null;
  const servingSize = packaging.servingSize.value;
  if (
    !servingSize ||
    (shape.drugFacts && !shape.servingSize) ||
    (shape.servingSize && sameServingSize(shape.servingSize, servingSize))
  ) {
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
