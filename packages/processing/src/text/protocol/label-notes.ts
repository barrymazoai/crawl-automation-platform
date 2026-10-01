import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { DV_SENTENCE } from "./label-footnotes.js";

const ENZYME =
  /(?:FU\s*[-–]\s*(?:enzyme activity in fibrinolytic units|fibrinolytic activity units)|SPU\s*[-–]\s*serratiopeptidase activity units|1 CFU\s*=\s*1 Colony Forming Unit)/i;
const TRIGLYCERIDES = /Reported as triglycerides/i;
const CAFFEINE = /Total Caffeine Yield:\s*\d+(?:\.\d+)?\s*mg per serving/i;
const FDA =
  /(?:These statements have|This statement has) not been evaluated by the (?:Food and Drug Administration|FDA)\.\s*This product is not intended to diagnose, treat, cure,? or prevent any disease/i;
const TIMING =
  /(?:At time of manufacture|At end of Best By Date|At Expiration Date under recommended storage conditions)/i;
const ORIGIN =
  /(?:Naturally occurring|Nutrient fermented from Saccharomyces cerevisiae|Enzyme Activated Mineral|Probiotic Fermented Nutrient)/i;
const CAPSULE = /Excludes capsule(?: and probiotic cultures)?/i;
const POTENCY =
  /(?:Colony forming units\.\s*Potency guaranteed until expiration, when stored as recommended|Minimum potency at time of manufacture\.\s*Live organisms per \d+ capsule serving)/i;
const ASPOROTATE =
  /(?:\[[*†]*\s*)?Asporotate[™®]? denotes Aspartate, Citrate, Orotate(?: \(milk, soy\))?\.?\]?/i;
const NOTES = [ENZYME, TRIGLYCERIDES, CAFFEINE, FDA, TIMING, ORIGIN, CAPSULE, POTENCY, ASPOROTATE];
const MARKERS = String.raw`[*†‡#+⁺¹²³◇^˄\s]*`;
const NOTE = String.raw`${MARKERS}(?:${NOTES.map((note) => note.source).join("|")})[.,]?`;
const LABEL_NOTES = new RegExp(`^(?:${DV_SENTENCE}|${NOTE}){1,8}$`, "i");

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
