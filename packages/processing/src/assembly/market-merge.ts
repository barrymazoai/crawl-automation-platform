import { isOrderedEvidencePolicy, type LabelCandidate } from "@crawl-automation/v3-contracts";
import type { AssemblyErrorCode } from "./assembly-errors.js";
import type { LabelEvidence, MergeState } from "./merge-state.js";

/** What the market merge rules read of the source being compared. */
export interface MarketPick {
  entry: LabelEvidence;
  candidate: Pick<LabelCandidate, "formula">;
  secondaryText: boolean;
  imageFirst: boolean;
  textFallback: boolean;
}

/** The page's difference only warns: an image leads (and wins, under ordered policies), or the market yields. */
export function textYields(
  state: MergeState,
  pick: MarketPick,
  at: { conflict: AssemblyErrorCode; imageWins: boolean },
): boolean {
  return (
    pageYields(state, pick, at.conflict) ||
    (pick.secondaryText &&
      (at.imageWins || !isOrderedEvidencePolicy(state.manifest.evidencePolicy)))
  );
}

/** KAN-243 (owner 2026-11-07, India): a page's formula that differs from the selected label image's yields to it. */
function pageYields(state: MergeState, pick: MarketPick, conflict: AssemblyErrorCode): boolean {
  return (
    state.market.pageFormulaYields &&
    !pick.textFallback &&
    conflict === "LABEL_PRODUCT.FORMULA_CONFLICT" &&
    pick.entry.kind === "text" &&
    state.formulaSource?.kind === "image"
  );
}

/**
 * KAN-243 (owner 2026-11-07, India): two readings of the label that name the same ingredients and amounts shorter or
 * longer agree (Methylcobalamin IP 1500 mcg, front and back), and are not two sections to join (Vitamin D3 60,000 IU,
 * front and back). Where a complete image leads, only between two label images: the collected record's check accepts
 * exactly that (sameIndianIngredients in v3-contracts).
 */
export function marketAgrees(state: MergeState, pick: MarketPick): boolean {
  const selected = state.formulaSource?.candidate.formula;
  const next = pick.candidate.formula;
  const images = pick.entry.kind === "image" && state.formulaSource?.kind === "image";
  return (
    (!pick.imageFirst || images) && !!selected && !!next && state.market.formulaFits(next, selected)
  );
}
