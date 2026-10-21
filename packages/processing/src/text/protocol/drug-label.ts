import {
  drugActiveHeading,
  drugExcludedSection,
  drugFactsHeading,
  drugSectionLines,
  factsHeadingLines,
  type LabelTextCandidate,
} from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../../label/validation-errors.js";
import { drugNoteExclusionAllowed } from "./drug-note-exclusions.js";

type Exclusion = LabelTextCandidate["exclusions"][number];
const INACTIVE_HEADING = /^Inactive(?:\s+ingredients?(?:\(s\))?)?\s*:?$/i;
const ACTIVE_HEADING = /^Active(?:\s+ingredients?(?:\(s\))?)?(?:\s+\(in each[^\n]+\))?\s*:?$/i;
const DRUG_SECTIONS =
  /^[ \t]*(?:Drug Facts|Active(?: ingredients?(?:\(s\))?)?(?:[ \t]+\(in each[^\n]+\))?|Purposes?|Uses|Warnings?|Directions|Other information|Inactive(?: ingredients?(?:\(s\))?)?|Questions\??)[ \t]*(?::[^\n]*|$)/gim;

/** The contracts' Drug Facts check is stricter about heading spelling; preserve its other requirements. */
export function drugHeadingAliasesAllowed(candidate: LabelTextCandidate): boolean {
  const formula = candidate.formula;
  return (
    !!formula?.drugFacts &&
    drugFactsHeading.test(formula.drugFacts.text) &&
    !!candidate.otherIngredients &&
    INACTIVE_HEADING.test(candidate.otherIngredients.heading.text.trim()) &&
    formula.columns.length > 0 &&
    formula.columns.every(
      (column) =>
        !!column.heading &&
        ACTIVE_HEADING.test(column.heading.text.trim()) &&
        column.rows.every(
          (row) =>
            row.kind === "nutrient" && row.parentRowIndex === null && row.dailyValue === null,
        ),
    )
  );
}

/** Only recognized Drug Facts sections can excuse their own content, never another section's rows. */
export function drugExclusionAllowed(
  exclusion: Exclusion,
  text: string,
  candidate?: LabelTextCandidate,
): boolean {
  if (exclusion.reason === "heading") {
    return drugHeadingExclusionAllowed(exclusion, text, candidate);
  }
  // Standard notes, whatever the model calls them (2026-09-30: HPUS notes tagged noise).
  if (["footnote", "metadata", "noise"].includes(exclusion.reason)) {
    return drugNoteExclusionAllowed(exclusion, candidate);
  }
  if (exclusion.reason !== "directions") {
    return false;
  }
  const sections = [...text.matchAll(drugSectionLines)];
  return sections.some((section, index) => {
    const heading = section[0].split(":")[0]?.trim() ?? "";
    const end = sections[index + 1]?.index ?? text.length;
    return (
      drugExcludedSection.test(heading) &&
      exclusion.quote.start >= section.index &&
      exclusion.quote.end <= end
    );
  });
}

function drugHeadingExclusionAllowed(
  exclusion: Exclusion,
  text: string,
  candidate?: LabelTextCandidate,
): boolean {
  const value = exclusion.quote.text.trim();
  return (
    drugFactsHeading.test(value) ||
    drugActiveHeading.test(value) ||
    ACTIVE_HEADING.test(value) ||
    /^Purposes?\s*:?$/i.test(value) ||
    /^Active ingredients?(?:\(s\))?\s+Purposes?$/i.test(value) ||
    purposeColumnHeadingAllowed(exclusion, candidate) ||
    adjacentIngredientsHeadingAllowed(exclusion, text, candidate)
  );
}

function purposeColumnHeadingAllowed(
  exclusion: Exclusion,
  candidate?: LabelTextCandidate,
): boolean {
  if (!/^Purposes?\s+[^\n\d]+$/i.test(exclusion.quote.text.trim())) {
    return false;
  }
  return !candidate?.formula?.columns.some((column) =>
    column.rows.some(
      (row) =>
        row.purpose &&
        exclusion.quote.start < row.purpose.end &&
        exclusion.quote.end > row.purpose.start,
    ),
  );
}

function adjacentIngredientsHeadingAllowed(
  exclusion: Exclusion,
  text: string,
  candidate?: LabelTextCandidate,
): boolean {
  const heading = candidate?.otherIngredients?.heading;
  return (
    /^Ingredients$/i.test(exclusion.quote.text.trim()) &&
    !!heading &&
    INACTIVE_HEADING.test(heading.text.trim()) &&
    exclusion.quote.end <= heading.start &&
    /^\s*$/.test(text.slice(exclusion.quote.end, heading.start))
  );
}

/** The cited Drug Facts heading must identify the sole panel; rows remain inside its active section. */
export function drugStructureCodes(
  candidate: LabelTextCandidate,
  text: string,
  range: { start: number; end: number },
): string[] {
  const formula = candidate.formula;
  if (!formula?.drugFacts) {
    return [];
  }
  const drugHeading = formula.drugFacts;
  const scoped = text.slice(range.start, range.end);
  const headings = [...scoped.matchAll(factsHeadingLines)];
  const first = headings[0];
  const boundary = Math.min(
    activeSectionEnd(scoped) + range.start,
    candidate.otherIngredients?.heading.start ?? text.length,
  );
  const valid =
    headings.length === 1 &&
    first !== undefined &&
    first.index + range.start === drugHeading.start &&
    drugFactsHeading.test(first[0]) &&
    formula.columns.every((column) => {
      const heading = column.heading;
      return (
        !!heading &&
        heading.start > drugHeading.end &&
        column.rows.every(
          (row) =>
            row.name.start >= heading.end &&
            [row.name, row.amount, row.purpose].every((field) => !field || field.end <= boundary),
        )
      );
    });
  const codes = valid ? [] : [labelValidationErrors.code("LABEL.FORMULA_INCOMPLETE")];
  return [...codes, ...drugIngredientCodes(candidate, text)];
}

/** A Drug Facts ingredient item cannot borrow text from Directions or Questions after its section. */
function drugIngredientCodes(candidate: LabelTextCandidate, text: string): string[] {
  const other = candidate.otherIngredients;
  if (!other) {
    return [];
  }
  const sections = [...text.matchAll(DRUG_SECTIONS)];
  const prefix = text.slice(
    text.lastIndexOf("\n", other.heading.start - 1) + 1,
    other.heading.start,
  );
  const atLineStart = /^\s*$/.test(prefix);
  const precededByIngredients =
    /^Ingredients\s+$/i.test(prefix) &&
    candidate.exclusions.some(
      (exclusion) =>
        exclusion.reason === "heading" &&
        /^Ingredients$/i.test(exclusion.quote.text.trim()) &&
        exclusion.quote.end <= other.heading.start &&
        /^\s*$/.test(text.slice(exclusion.quote.end, other.heading.start)),
    );
  const end = sections.find((section) => section.index > other.heading.start)?.index ?? text.length;
  const valid =
    INACTIVE_HEADING.test(other.heading.text.trim()) &&
    (atLineStart || precededByIngredients) &&
    other.items.every((item) => item.start >= other.heading.end && item.end <= end);
  return valid ? [] : [labelValidationErrors.code("LABEL.INGREDIENT_ROLE_INVALID")];
}

function activeSectionEnd(text: string): number {
  const sections = [...text.matchAll(DRUG_SECTIONS)];
  return (
    sections.find((section) =>
      /^(?:Uses|Warnings?|Directions|Other information|Inactive|Questions)/i.test(section[0]),
    )?.index ?? text.length
  );
}
