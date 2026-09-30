import { drugExclusionAllowed } from "./drug-label.js";
import { labelHeadingAllowed } from "./label-headings.js";
import { labelValidationErrors } from "../../label/validation-errors.js";
import type { LabelTextCandidateSchema } from "@crawl-automation/v3-contracts";
import type { z } from "zod";

type Candidate = z.infer<typeof LabelTextCandidateSchema>;
type Exclusion = Candidate["exclusions"][number];
interface Judged {
  candidate: Candidate;
  text: string;
  policyVersion: string;
}

const DV_BASIS = new RegExp(
  String.raw`percent\s+daily\s+values?\s+(?:\(dv\)\s+)?(?:are\s+)?` +
    String.raw`based\s+(?:on|upon)\s+(?:a\s+)?2,?000\s+calorie\s+diet`,
  "i",
);
const DV_NOT_ESTABLISHED = new RegExp(
  String.raw`(?:(?:percent|%)\s*)?daily\s+values?(?:\s*\(%?dv\))?\s+` +
    String.raw`not\s+(?:established|determined)`,
  "i",
);
// The long FDA form's second sentence.
const DV_NEEDS =
  /your\s+daily\s+values?\s+may\s+be\s+higher\s+or\s+lower\s+depending\s+on\s+your\s+calorie\s+needs/i;
// The long Nutrition Facts footnote: "The % Daily Value (DV) tells you how much a nutrient in a serving of food
// contributes to a daily diet. 2,000 calories a day is used for general nutrition advice."
const DV_TELLS =
  /the\s+%\s*daily\s+value\s+(?:\(dv\)\s+)?tells\s+you\s+how\s+much\s+a\s+nutrient\s+in\s+a\s+serving\s+of\s+food\s+contributes\s+to\s+a\s+daily\s+diet\.?\s*2,?000\s+calories\s+a\s+day\s+(?:is|are)\s+used\s+for\s+general\s+nutrition\s+advice/i;
// Accept one to three complete DV sentences; a recognized prefix cannot hide other label text.
const DV_SENTENCE = String.raw`[*+†‡§¶\s]*(?:${DV_BASIS.source}|${DV_NOT_ESTABLISHED.source}|${DV_NEEDS.source}|${DV_TELLS.source})\.?`;
const STANDARD_FOOTNOTE = new RegExp(`^(?:${DV_SENTENCE}){1,3}$`, "i");
const ESTABLISHED_FOOTNOTE =
  /^[*+†]+\s*(?:percent\s+daily\s+values?|daily\s+values?)(?:\s*\(DV\))?\s+(?:not established\.?|not determined\.?)$/i;
const ALLERGEN = /^(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|processed\s+(?:in|on))/i;

/** Unrecognized exclusions retain `LABEL.COVERAGE_UNCERTAIN`; marketing always stays for Review. */
export function exclusionCodes(judged: Judged): string[] {
  const uncertain = judged.candidate.exclusions.some(
    (exclusion) =>
      !exactlyPlacedExclusion(exclusion, judged) &&
      !allowedExclusion(exclusion, judged) &&
      !(
        judged.policyVersion === "label-text/5" &&
        judged.candidate.formula?.drugFacts &&
        drugExclusionAllowed(exclusion, judged.text)
      ),
  );
  return uncertain ? [labelValidationErrors.code("LABEL.COVERAGE_UNCERTAIN")] : [];
}

/** label-text/4: the heading field itself, a field's printed prefix, or a DV footnote symbol. */
function exactlyPlacedExclusion(exclusion: Exclusion, judged: Judged): boolean {
  if (!["label-text/4", "label-text/5"].includes(judged.policyVersion)) {
    return false;
  }
  return (
    isIngredientHeadingField(exclusion, judged) ||
    isFieldPrefix(exclusion, judged) ||
    isDvFootnote(exclusion)
  );
}

/** The exact span of the Other Ingredients heading field. */
function isIngredientHeadingField(exclusion: Exclusion, judged: Judged): boolean {
  const heading = judged.candidate.otherIngredients?.heading;
  const quote = exclusion.quote;
  return (
    exclusion.reason === "heading" && heading?.start === quote.start && heading.end === quote.end
  );
}

/** "Serving Size" or "Servings Per Container", printed right before its own field's value. */
function isFieldPrefix(exclusion: Exclusion, judged: Judged): boolean {
  if (exclusion.reason !== "metadata") {
    return false;
  }
  const value = exclusion.quote.text.trim();
  const formula = judged.candidate.formula;
  const field = /^Serving Size\s*:?$/i.test(value)
    ? formula?.servingSize
    : /^Servings? Per Container\s*:?$/i.test(value)
      ? formula?.servingsPerContainer
      : null;
  if (!field || exclusion.quote.end > field.start) {
    return false;
  }
  return /^\s*:?\s*$/.test(judged.text.slice(exclusion.quote.end, field.start));
}

/** "† Daily Value not established." or a lone DV symbol. */
function isDvFootnote(exclusion: Exclusion): boolean {
  const value = exclusion.quote.text.trim();
  return (
    exclusion.reason === "footnote" && (ESTABLISHED_FOOTNOTE.test(value) || /^[*+†]+$/.test(value))
  );
}

function allowedExclusion(exclusion: Exclusion, judged: Judged): boolean {
  const value = exclusion.quote.text.trim();
  if (
    ["heading", "metadata", "footnote", "noise"].includes(exclusion.reason) &&
    (labelHeadingAllowed(value, judged.candidate) || STANDARD_FOOTNOTE.test(value))
  ) {
    return true;
  }
  switch (exclusion.reason) {
    case "allergen":
      return ALLERGEN.test(value);
    case "directions":
      return allowedDirections(exclusion, judged);
    case "noise":
      return /^[+•■|/]$/.test(value) || isBlendLinkingWord(exclusion, judged);
    default:
      return false;
  }
}

/** label-text/3+: "consisting of" / "and" between a blend total and one of its components. */
function isBlendLinkingWord(exclusion: Exclusion, judged: Judged): boolean {
  const quote = exclusion.quote;
  if (!["label-text/3", "label-text/4", "label-text/5"].includes(judged.policyVersion)) {
    return false;
  }
  if (!/^(?:consisting of|and)$/i.test(quote.text.trim())) {
    return false;
  }
  return (judged.candidate.formula?.columns ?? []).some((column) =>
    column.rows.some(
      (row, index) =>
        row.kind === "blend_total" &&
        row.name.end <= quote.start &&
        column.rows.some(
          (child) =>
            child.kind === "blend_component" &&
            child.parentRowIndex === index &&
            child.name.end >= quote.end,
        ),
    ),
  );
}

function allowedDirections(exclusion: Exclusion, judged: Judged): boolean {
  if (judged.candidate.formula?.drugFacts) {
    return judged.policyVersion === "label-text/5" && drugExclusionAllowed(exclusion, judged.text);
  }
  return (
    /^(?:suggested\s+use|directions)\s*:/i.test(exclusion.quote.text.trim()) &&
    !/supplement\s+facts|other\s+ingredients/i.test(exclusion.quote.text)
  );
}
