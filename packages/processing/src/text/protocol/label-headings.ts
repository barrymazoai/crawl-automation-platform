import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import type { Span } from "./evidence-lines.js";
import { minorIngredientHeading } from "./ingredient-boundaries.js";

// Kate Farms Pediatric Peptide 1.0 (2026-10-22): "Nutrition Info" / "Composition | Amount" are
// printed panel and column headings. They carry no serving-size claim; the table rows provide the amounts.
// Hayat Vitamins prints its servings field as "Server Per Container" (2026-10-29).
const SERVINGS_PER_CONTAINER = String.raw`serv(?:ings?|ers?)\s+per\s+container`;
const HEADING = new RegExp(
  String.raw`^[*+†‡§¶\s]*(?:supplement\s+facts|nutrition\s+facts|nutrition\s+info|nutrition(?:al)?\s+information|view\s+nutrition\s+label|` +
    String.raw`serving\s+size\s*:?|${SERVINGS_PER_CONTAINER}\s*:?)\.?$`,
  "i",
);
const COLUMN =
  String.raw`(?:(?:amt|amounts?)(?:\s+per\s+serving)?|composition|nutrient|ingredients?|per\s+serving|` +
  String.raw`%\s*dv|dv\s*%|(?:%\s*)?daily\s+value)`;
const SYMBOLS = String.raw`[*+†‡§¶•■|/\s]`;
const TABLE_HEADING = new RegExp(
  String.raw`^${SYMBOLS}*${COLUMN}(?:${SYMBOLS}+${COLUMN})*${SYMBOLS}*:?\.?$`,
  "i",
);
const SERVING_HEADER = /^(Serving Size|Serv(?:ings?|ers?) Per Container)\s*:\s*(\S[\s\S]*)$/i;
// Column headers naming the serving of each column ("Amount Per Serving | 1 Stick | % DV*", Boba Tea Protein;
// "1 Scoop | % DV* | 2 Scoops | % DV*") or the DV basis ("2000-Calorie Diet | % DV", Hayat Vitamins), 2026-10-29.
const SERVING_COUNT = String.raw`\d+\s+(?:scoops?|sticks?|capsules?|caplets?|tablets?|softgels?|gummies|packets?|servings?)`;
const CALORIE_DIET = String.raw`2,?000[-\s]calorie\s+diet`;
const COLUMN_CELL = String.raw`(?:${COLUMN}|${SERVING_COUNT}|${CALORIE_DIET})`;
const SERVING_COLUMNS = new RegExp(
  String.raw`^${SYMBOLS}*${COLUMN_CELL}(?:${SYMBOLS}+${COLUMN_CELL})*${SYMBOLS}*:?\.?$`,
  "i",
);
const COLUMN_HEADER_WORD = new RegExp(
  String.raw`%\s*dv|dv\s*%|daily\s+value|amount|${CALORIE_DIET}`,
  "i",
);

/**
 * A whole column-header line. A serving count alone ("2 Capsules") is not one: it may be the serving size value, so a
 * header needs a DV, amount or calorie-diet word.
 */
export function columnHeaderText(value: string): boolean {
  return (
    TABLE_HEADING.test(value) || (SERVING_COLUMNS.test(value) && COLUMN_HEADER_WORD.test(value))
  );
}

/** Only table vocabulary, or a serving header whose complete value is already captured. */
export function labelHeadingAllowed(value: string, candidate: LabelTextCandidate): boolean {
  if (HEADING.test(value) || columnHeaderText(value)) {
    return true;
  }
  const header = SERVING_HEADER.exec(value);
  if (!header) {
    return false;
  }
  const field = /^Serving Size$/i.test(header[1] ?? "")
    ? candidate.formula?.servingSize
    : candidate.formula?.servingsPerContainer;
  const words = (text: string) => text.replace(/\s+/gu, " ").trim();
  return !!field && words(field.text) === words(header[2] ?? "");
}

const INGREDIENT_SUBHEADING =
  /^(?:each\s+capsule\s+contains\s*:|other\s+ingredients\s*:\s*may\s+contain\s+any\s+or\s+all\s+of\s+the\s+following\s*:|contains\s*:)$/i;

/** Only a cited clause that leads directly into anchored ingredients can be excluded as a list subheading. */
export function ingredientSubheadingAllowed(
  value: string,
  source: { candidate: LabelTextCandidate; span: Span; text: string },
): boolean {
  if (!minorIngredientHeading(value) && !INGREDIENT_SUBHEADING.test(value)) {
    return false;
  }
  if (/^each\s+capsule\s+contains\s*:$/i.test(value)) {
    return capsuleHeadingBeforeRow(source);
  }
  const items = source.candidate.otherIngredients?.items ?? [];
  const next = items.find((item) => item.start >= source.span.end);
  return !!next && /^\s*[,;:]?\s*$/.test(source.text.slice(source.span.end, next.start));
}

function capsuleHeadingBeforeRow(source: {
  candidate: LabelTextCandidate;
  span: Span;
  text: string;
}): boolean {
  const rows = source.candidate.formula?.columns.flatMap((column) => column.rows) ?? [];
  const next = rows.find((row) => row.name.start >= source.span.end)?.name;
  return !!next && /^[\s:,;]*$/.test(source.text.slice(source.span.end, next.start));
}

/** Facts headings above the extracted panel, and prefixes immediately adjoining their values. */
export function anchoredHeadings(candidate: LabelTextCandidate, text: string, range: Span): Span[] {
  const formula = candidate.formula;
  if (!formula) {
    return [];
  }
  const spans = factsHeadingSpan(formula, text, range);
  for (const [key, prefix] of [
    ["servingSize", /Serving Size\s*:?\s*$/i],
    ["servingsPerContainer", /Serv(?:ings?|ers?) Per Container\s*:?\s*$/i],
  ] as const) {
    const field = formula[key];
    const match = field && prefix.exec(text.slice(range.start, field.start));
    if (match && field) {
      spans.push({ start: range.start + match.index, end: field.start });
    }
  }
  return spans;
}

/** An isolated Amazon Ingredients line labels the immediately following quoted formula or ingredient clause. */
export function isolatedIngredientsHeadings(
  candidate: LabelTextCandidate,
  text: string,
  range: Span,
): Span[] {
  const headings = [
    ...(candidate.formula?.columns.map((column) => column.heading).filter((field) => !!field) ??
      []),
    candidate.otherIngredients?.heading,
  ].filter((field) => !!field);
  return [
    ...text.slice(range.start, range.end).matchAll(/^[ \t]*Ingredients[ \t]*(?=\r?$)/gim),
  ].flatMap((match) => {
    const start = range.start + match.index;
    const end = start + match[0].length;
    const next = /^(?:\r?\n[ \t]*)+([^\r\n]+)/.exec(text.slice(end, range.end));
    const nextLine = next?.[1];
    if (!next || !nextLine) {
      return [];
    }
    const lineStart = end + next[0].length - nextLine.length;
    const lineEnd = lineStart + nextLine.length;
    const first = headings.find(
      (field) =>
        field.start >= lineStart &&
        field.start < lineEnd &&
        /^(?:Drug classification:\s*)?$/i.test(text.slice(lineStart, field.start)),
    );
    return first ? [{ start, end }] : [];
  });
}

function factsHeadingSpan(
  formula: NonNullable<LabelTextCandidate["formula"]>,
  text: string,
  range: Span,
): Span[] {
  const headings = [
    ...text
      .slice(range.start, range.end)
      .matchAll(
        /(?:^|\n)[ \t]*((?:(?:Supplement|Nutrition|Drug)\s+Facts|Nutrition\s+Info|Nutrition(?:al)?\s+Information))[ \t]*(?=\n|$)/gi,
      ),
  ];
  const firstRow = formula.columns[0]?.rows[0]?.name;
  if (
    !firstRow ||
    headings.some((heading) => /\bDrug\s+Facts/i.test(heading[0]) && !formula.drugFacts)
  ) {
    return [];
  }
  const spans = headings.map((heading) => ({
    start: heading.index + range.start,
    end: heading.index + range.start + heading[0].length,
  }));
  // A store page may print the heading twice above one panel, as a tab title and on the panel (Aspire Nutrition
  // 2026-10-29). Every heading above the first row is structural; one below it may open a second panel, and that
  // still keeps the answer incomplete.
  if (spans.length === 1 || spans.every((span) => span.end <= firstRow.start)) {
    return spans.filter((span) => span.end <= firstRow.start);
  }
  return [];
}
