import type { LabelTextCandidateSchema } from "@crawl-automation/v3-contracts";
import type { z } from "zod";

type Candidate = z.infer<typeof LabelTextCandidateSchema>;
type Exclusion = Candidate["exclusions"][number];
interface Judged {
  candidate: Candidate;
  text: string;
  policyVersion: string;
}

const HEADING =
  /^(?:supplement\s+facts|nutrition\s+facts|view\s+nutrition\s+label|serving\s+size\s*:?|servings?\s+per\s+container\s*:?|amounts?\s+per\s+serving|%\s*(?:dv|daily\s+value))$/i;
const SYMBOL_FOOTNOTE = /^[*+†]+\s*(?:percent\s+daily\s+values|daily\s+values?)/i;
// The FDA's standard footnote may stand alone, without a leading symbol:
// "Percent Daily Values are based on a 2,000 calorie diet." (2026-09-29, Swanson label core text).
const STANDARD_FOOTNOTE =
  /^[*+†]*\s*percent\s+daily\s+values?\s+(?:\(dv\)\s+)?are\s+based\s+on\s+a\s+2,?000\s+calorie\s+diet\.?$/i;
const ESTABLISHED_FOOTNOTE =
  /^[*+†]+\s*(?:percent\s+daily\s+values?|daily\s+values?)(?:\s*\(DV\))?\s+(?:not established\.?|not determined\.?)$/i;
const ALLERGEN = /^(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|processed\s+(?:in|on))/i;

/** `LABEL.COVERAGE_UNCERTAIN` when any excluded text lacks an accepted reason; marketing and noise stay for Review. */
export function exclusionCodes(judged: Judged): string[] {
  const uncertain = judged.candidate.exclusions.some(
    (exclusion) =>
      !exactlyPlacedExclusion(exclusion, judged) && !allowedExclusion(exclusion, judged),
  );
  return uncertain ? ["LABEL.COVERAGE_UNCERTAIN"] : [];
}

/** label-text/4: the heading field itself, a field's printed prefix, or a DV footnote symbol. */
function exactlyPlacedExclusion(exclusion: Exclusion, judged: Judged): boolean {
  if (judged.policyVersion !== "label-text/4") {
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
  switch (exclusion.reason) {
    case "heading":
      return HEADING.test(value);
    case "footnote":
      return SYMBOL_FOOTNOTE.test(value) || STANDARD_FOOTNOTE.test(value);
    case "allergen":
      return ALLERGEN.test(value);
    case "directions":
      return (
        /^(?:suggested\s+use|directions)\s*:/i.test(value) &&
        !/supplement\s+facts|other\s+ingredients/i.test(value)
      );
    case "noise":
      return isBlendLinkingWord(exclusion, judged);
    default:
      return false;
  }
}

/** label-text/3+: "consisting of" / "and" between a blend total and one of its components. */
function isBlendLinkingWord(exclusion: Exclusion, judged: Judged): boolean {
  const quote = exclusion.quote;
  if (!["label-text/3", "label-text/4"].includes(judged.policyVersion)) {
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
