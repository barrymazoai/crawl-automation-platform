import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { DV_SENTENCE, FDA_DISCLAIMER_SENTENCE } from "./label-footnotes.js";
import { DOSE } from "./label-rows.js";

const ALLERGEN =
  /^(?:contains\b|may\s+contain\b|free\s+(?:of|from)\b|manufactured\s+(?:in|on)\b|processed\s+(?:in|on)\b)/i;
// "Contains <2% of:", "Contains less than 2% of:" and "Contains 2% or less of:" all open an ingredient list.
const INGREDIENT_PERCENT =
  /^contains\s*(?:(?:less\s+than|<)\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*or\s+less)/i;
const TRADEMARK = /^(?:trademark\b[^\n]*|[^\n]*\bis a (?:registered )?trademark of\b[^\n]*)$/i;

/** "Contains fish" is an allergen statement; "Contains <2% of" starts an ingredient list. */
export function allergenStatement(value: string): boolean {
  return !value.includes("\n") && ALLERGEN.test(value) && !INGREDIENT_PERCENT.test(value);
}

/** Trademark notices are printed label text even when classified as marketing. */
export function trademarkStatement(value: string): boolean {
  return TRADEMARK.test(value);
}

const ENZYME =
  /(?:FU\s*[-–]\s*(?:enzyme activity in fibrinolytic units|fibrinolytic activity units)|SPU\s*[-–]\s*serratiopeptidase activity units|1 CFU\s*=\s*1 Colony Forming Unit)/i;
const TRIGLYCERIDES = /Reported as triglycerides/i;
const CAFFEINE = /Total Caffeine Yield:\s*\d+(?:\.\d+)?\s*mg per serving/i;
const TIMING =
  /(?:At time of manufacture|At end of Best By Date|At Expiration Date under recommended storage conditions)/i;
const ORIGIN =
  /(?:Naturally occurring|Nutrient fermented from Saccharomyces cerevisiae|Enzyme Activated Mineral|Probiotic Fermented Nutrient)/i;
const CAPSULE = /Excludes capsule(?: and probiotic cultures)?/i;
const POTENCY =
  /(?:Colony forming units\.\s*Potency guaranteed until expiration, when stored as recommended|Minimum potency at time of manufacture\.\s*Live organisms per \d+ capsule serving)/i;
const ASPOROTATE =
  /(?:\[[*†]*\s*)?Asporotate[™®]? denotes Aspartate, Citrate, Orotate(?: \(milk, soy\))?\.?\]?/i;
const NOTES = [
  ENZYME,
  TRIGLYCERIDES,
  CAFFEINE,
  FDA_DISCLAIMER_SENTENCE,
  TIMING,
  ORIGIN,
  CAPSULE,
  POTENCY,
  ASPOROTATE,
];
const MARKERS = String.raw`[*†‡#+⁺¹²³◇^˄\s]*`;
const NOTE = String.raw`${MARKERS}(?:${NOTES.map((note) => note.source).join("|")})[.,]?`;
const LABEL_NOTES = new RegExp(`^(?:${DV_SENTENCE}|${NOTE}){1,8}$`, "i");
const NET_WEIGHT = /^net\s*(?:wt|weight)\b[^\n]*$/i;
const NATURALLY_DERIVED = /^[*†‡]?\s*naturally-derived ingredient\.?$/i;
const PHARMACOPOEIA = /\b(?:HPUS|Homeopathic Pharmacopoeia)\b/i;

/** Printed package weight and explanatory label lines may be omitted as metadata or noise. */
export function labelMetadataAllowed(value: string): boolean {
  return (
    NET_WEIGHT.test(value) ||
    NATURALLY_DERIVED.test(value) ||
    // A pharmacopoeia sentence followed by a nutrient amount may conceal a formula row.
    (!value.includes("\n") && PHARMACOPOEIA.test(value) && !DOSE.test(value))
  );
}

/** Whole printed notes only: preserve citations and totals without creating or changing formula rows. */
export function labelNoteAllowed(
  exclusion: LabelTextCandidate["exclusions"][number],
  candidate: LabelTextCandidate,
): boolean {
  return (
    !!candidate.formula &&
    ["footnote", "metadata", "noise"].includes(exclusion.reason) &&
    LABEL_NOTES.test(exclusion.quote.text.trim())
  );
}
