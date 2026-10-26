import type { EnrichmentCandidate } from "@crawl-automation/v3-contracts";
import { words } from "./printed.js";

/**
 * The printed names that establish each form. Owner 2026-10-26: common page names count too (caplets were dropped
 * as `other`, "90 Soft Chews" and drink mixes as `unknown`), matching the prompt's form names.
 */
const printedForms: Record<EnrichmentCandidate["form"], string[]> = {
  capsule: ["capsule", "capsules", "caps", "vcaps", "vegcap", "vegcaps", "liqui caps", "liquicaps"],
  softgel: ["softgel", "softgels", "sgels", "soft gel", "soft gels"],
  tablet: ["tablet", "tablets", "caplet", "caplets", "tabs"],
  chewable: ["chewable", "chewables", "chew", "chews", "chewies"],
  gummy: ["gummy", "gummies", "jelly bean", "jelly beans"],
  powder: ["powder", "powders", "drink mix", "scoop", "scoops", "stick pack", "stick packs"],
  liquid: [
    "liquid",
    "liquids",
    "shot",
    "shots",
    "beverage",
    "beverages",
    "shake",
    "shakes",
    "tincture",
    "syrup",
  ],
  drops: ["drop", "drops"],
  spray: ["spray", "sprays"],
  bar: ["bar", "bars"],
  lozenge: ["lozenge", "lozenges"],
  other: [],
  unknown: [],
};

/** Volume alone does not establish dosage form; powders can use volumetric serving measures. */
export function groundForm(candidate: EnrichmentCandidate, printed: string[]) {
  const form = candidate.form;
  if (["other", "unknown"].includes(form)) {
    return [];
  }
  // Whole words only, so "bars" never matches inside "barley" and a phrase must appear in that order.
  const text = ` ${printed.map((entry) => words(entry).join(" ")).join(" | ")} `;
  if (printedForms[form].some((name) => text.includes(` ${name} `))) {
    return [];
  }
  candidate.form = "unknown";
  return [`form-not-printed:${form}`];
}
