import type { EnrichmentCandidate } from "@crawl-automation/v3-contracts";

const printedForms: Record<EnrichmentCandidate["form"], string[]> = {
  capsule: ["capsule", "capsules"],
  softgel: ["softgel", "softgels"],
  tablet: ["tablet", "tablets"],
  chewable: ["chewable", "chewables"],
  gummy: ["gummy", "gummies"],
  powder: ["powder", "powders"],
  liquid: ["liquid", "liquids"],
  drops: ["drop", "drops"],
  spray: ["spray", "sprays"],
  bar: ["bar", "bars"],
  lozenge: ["lozenge", "lozenges"],
  other: [],
  unknown: [],
};

/** Volume alone does not establish dosage form; powders can use volumetric serving measures. */
export function groundForm(candidate: EnrichmentCandidate, source: Set<string>) {
  const form = candidate.form;
  if (["other", "unknown"].includes(form) || printedForms[form].some((word) => source.has(word))) {
    return [];
  }
  candidate.form = "unknown";
  return [`form-not-printed:${form}`];
}
