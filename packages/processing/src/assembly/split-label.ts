import {
  assessLabelCandidate,
  completeLabelSections,
  labelImageIntegrityCodes,
} from "@crawl-automation/v3-contracts";
import type { LabelEvidence } from "./merge-state.js";

/** The parts a selected label carries; /7 may keep one of them (owner 2026-10-06). */
export interface LabelParts {
  formula: boolean;
  ingredients: boolean;
}

/**
 * Coverage only: field choice and conflicts still run through the existing /6 merger. With `onePart` (/7), whole
 * printed sections of one part are enough; the missing part is left out, never invented.
 */
export function splitLabel(provenance: LabelEvidence[], onePart = false) {
  const sections = labelSections(provenance);
  const entries = [...sections.values()];
  const formula = entries.find((entry) => entry.candidate.formulaComplete);
  const ingredients = entries.find(
    (entry) =>
      entry.candidate.ingredientsComplete &&
      (entry.candidate.otherIngredients || entry.id === formula?.id),
  );
  if (!formula || !ingredients) {
    return onePart ? onePartLabel(sections, formula ?? ingredients) : null;
  }
  const candidate = {
    ...formula.candidate,
    otherIngredients: ingredients.candidate.otherIngredients,
    ingredientsComplete: true,
  } as LabelEvidence["candidate"];
  if (assessLabelCandidate(candidate).status !== "candidate") {
    return null;
  }
  return {
    sections,
    complete: { ...formula, candidate } as LabelEvidence,
    images: formula.kind === "image" && ingredients.kind === "image",
    parts: { formula: true, ingredients: true } as LabelParts,
  };
}

/** Whole printed sections of each intact source. */
function labelSections(provenance: LabelEvidence[]) {
  const sections = new Map<string, LabelEvidence>();
  for (const entry of provenance) {
    const candidate = completeLabelSections(entry.candidate);
    if (
      candidate &&
      !(entry.kind === "image" && labelImageIntegrityCodes(entry.candidate).length)
    ) {
      sections.set(entry.id, { ...entry, candidate } as LabelEvidence);
    }
  }
  return sections;
}

function onePartLabel(sections: Map<string, LabelEvidence>, entry: LabelEvidence | undefined) {
  if (!entry) {
    return null;
  }
  const formula = entry.candidate.formulaComplete;
  const candidate = formula
    ? { ...entry.candidate, otherIngredients: null, ingredientsComplete: false }
    : { ...entry.candidate, formula: null, formulaComplete: false };
  return {
    sections,
    complete: { ...entry, candidate } as LabelEvidence,
    images: false,
    parts: { formula, ingredients: !formula } as LabelParts,
  };
}
