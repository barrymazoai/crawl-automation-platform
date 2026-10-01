import {
  assessLabelCandidate,
  completeLabelSections,
  labelImageIntegrityCodes,
} from "@crawl-automation/v3-contracts";
import type { LabelEvidence } from "./merge-state.js";

/** Coverage only: field choice and conflicts still run through the existing /6 merger. */
export function splitLabel(provenance: LabelEvidence[]) {
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
  const entries = [...sections.values()];
  const formula = entries.find((entry) => entry.candidate.formulaComplete);
  const ingredients = entries.find(
    (entry) =>
      entry.candidate.ingredientsComplete &&
      (entry.candidate.otherIngredients || entry.id === formula?.id),
  );
  if (!formula || !ingredients) {
    return null;
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
  };
}
