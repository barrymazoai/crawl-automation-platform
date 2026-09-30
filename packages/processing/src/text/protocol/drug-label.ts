import {
  drugActiveHeading,
  drugExcludedSection,
  drugFactsHeading,
  drugSectionLines,
  factsHeadingLines,
  type LabelTextCandidate,
} from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../../label/validation-errors.js";

type Exclusion = LabelTextCandidate["exclusions"][number];
const HPUS_NOTE =
  String.raw`The letters? ["“]?HPUS["”]? indicate that ` +
  String.raw`(?:this ingredient|the components?(?:\(s\))? in (?:this|the) product) ` +
  String.raw`(?:is|are) officially (?:included|monographed) in the ` +
  String.raw`Homeopathic Pharmacop(?:oeia|eia) of the United States`;
const DILUTION_NOTE = String.raw`C, K, CK, and X are homeopathic dilutions`;
const FDA_USES_NOTE = String.raw`These ["“]Uses["”] have not been evaluated by the FDA`;
const HOMEOPATHIC_NOTE = new RegExp(
  String.raw`^(?:[*\s]*(?:${HPUS_NOTE}|${DILUTION_NOTE}|${FDA_USES_NOTE})\.?\s*){1,2}$`,
  "i",
);
const TRACE_NOTE = new RegExp(
  String.raw`^\(contains less than (?:than )?[\d⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉.]+` +
    String.raw`(?:[-⁻₋][\d⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+)? mg [a-z ]+\)$`,
  "i",
);

/** Only recognized Drug Facts sections can excuse their own content, never another section's rows. */
export function drugExclusionAllowed(exclusion: Exclusion, text: string): boolean {
  const { quote, reason } = exclusion;
  const value = quote.text.trim();
  if (reason === "heading") {
    return (
      drugFactsHeading.test(value) ||
      drugActiveHeading.test(value) ||
      /^Purpose\s*:?$/i.test(value) ||
      /^Active ingredients?(?:\(s\))?\s+Purpose$/i.test(value)
    );
  }
  // Standard notes, whatever the model calls them (2026-09-30: HPUS notes tagged noise).
  if (reason === "footnote" || reason === "metadata" || reason === "noise") {
    return HOMEOPATHIC_NOTE.test(value) || TRACE_NOTE.test(value);
  }
  if (reason !== "directions") {
    return false;
  }
  const sections = [...text.matchAll(drugSectionLines)];
  return sections.some((section, index) => {
    const heading = section[0].split(":")[0]?.trim() ?? "";
    const end = sections[index + 1]?.index ?? text.length;
    return drugExcludedSection.test(heading) && quote.start >= section.index && quote.end <= end;
  });
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
  const boundary = activeSectionEnd(scoped) + range.start;
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
  const sections = [...text.matchAll(drugSectionLines)];
  const index = sections.findIndex((section) => section.index === other.heading.start);
  const end = sections[index + 1]?.index ?? text.length;
  const valid =
    index >= 0 && other.items.every((item) => item.start >= other.heading.end && item.end <= end);
  return valid ? [] : [labelValidationErrors.code("LABEL.INGREDIENT_ROLE_INVALID")];
}

function activeSectionEnd(text: string): number {
  const sections = [...text.matchAll(drugSectionLines)];
  return (
    sections.find((section) =>
      /^(?:Uses|Warnings?|Directions|Other information|Inactive ingredients|Questions)/i.test(
        section[0],
      ),
    )?.index ?? text.length
  );
}
