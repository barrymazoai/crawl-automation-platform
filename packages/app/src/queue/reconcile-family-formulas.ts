import { appErrors } from "../errors.js";
import type { FamilyFormulaOutcomes, FamilyFormulaQuery } from "./family-formula-outcome.js";

/** The approved WF policy shares only exact ASIN/variant Amazon formulas; no capture or requeue. */
export async function reconcileFamilyFormulas(
  store: Partial<FamilyFormulaOutcomes>,
  query: FamilyFormulaQuery,
) {
  if (!store.familyOutcomes || !store.recordFamilyOutcome || !store.findFamilyFormula) {
    throw appErrors.create("QUEUE.NOT_CONFIGURED");
  }
  for (const outcome of await store.familyOutcomes(query)) {
    if (outcome.status === "formula-linked") {
      continue;
    }
    const known = await store.findFamilyFormula({
      channels: ["amazon"],
      listingId: outcome.listingId,
      variantId: outcome.variantId,
    });
    if (known) {
      await store.recordFamilyOutcome({
        ...outcome,
        status: "formula-linked",
        formulaOperationId: known.operationId,
      });
    }
  }
  return store.familyOutcomes(query);
}
