import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import type { Span } from "./evidence-lines.js";

const HEADING = new RegExp(
  String.raw`^[*+†‡§¶\s]*(?:supplement\s+facts|nutrition\s+facts|view\s+nutrition\s+label|` +
    String.raw`serving\s+size\s*:?|servings?\s+per\s+container\s*:?)\.?$`,
  "i",
);
const COLUMN =
  String.raw`(?:(?:amt|amounts?)(?:\s+per\s+serving)?|ingredients?|per\s+serving|` +
  String.raw`%\s*dv|dv\s*%|(?:%\s*)?daily\s+value)`;
const SYMBOLS = String.raw`[*+†‡§¶•■|/\s]`;
const TABLE_HEADING = new RegExp(
  String.raw`^${SYMBOLS}*${COLUMN}(?:${SYMBOLS}+${COLUMN})*${SYMBOLS}*:?\.?$`,
  "i",
);
const SERVING_HEADER = /^(Serving Size|Servings? Per Container)\s*:\s*(\S[\s\S]*)$/i;

/** Only table vocabulary, or a serving header whose complete value is already captured. */
export function labelHeadingAllowed(value: string, candidate: LabelTextCandidate): boolean {
  if (HEADING.test(value) || TABLE_HEADING.test(value)) {
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

const MINOR_HEADING =
  /^(?:contains\s+)?(?:(?:less\s+than|<)\s*2\s*%|2\s*%\s+or\s+less)\s+of(?:\s+(?:each\s+of\s+)?the\s+following)?\s*:?$/i;
const INGREDIENT_SUBHEADING =
  /^(?:each\s+capsule\s+contains\s*:|other\s+ingredients\s*:\s*may\s+contain\s+any\s+or\s+all\s+of\s+the\s+following\s*:|contains\s*:)$/i;

/** Only a cited clause that leads directly into anchored ingredients can be excluded as a list subheading. */
export function ingredientSubheadingAllowed(
  value: string,
  source: { candidate: LabelTextCandidate; span: Span; text: string },
): boolean {
  if (!MINOR_HEADING.test(value) && !INGREDIENT_SUBHEADING.test(value)) {
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

/** A sole facts heading before the extracted panel, and prefixes immediately adjoining their values. */
export function anchoredHeadings(candidate: LabelTextCandidate, text: string, range: Span): Span[] {
  const formula = candidate.formula;
  if (!formula) {
    return [];
  }
  const spans = factsHeadingSpan(formula, text, range);
  for (const [key, prefix] of [
    ["servingSize", /Serving Size\s*:?\s*$/i],
    ["servingsPerContainer", /Servings? Per Container\s*:?\s*$/i],
  ] as const) {
    const field = formula[key];
    const match = field && prefix.exec(text.slice(range.start, field.start));
    if (match && field) {
      spans.push({ start: range.start + match.index, end: field.start });
    }
  }
  return spans;
}

function factsHeadingSpan(
  formula: NonNullable<LabelTextCandidate["formula"]>,
  text: string,
  range: Span,
): Span[] {
  const headings = [
    ...text
      .slice(range.start, range.end)
      .matchAll(/(?:^|\n)[ \t]*((?:Supplement|Nutrition|Drug)\s+Facts)[ \t]*(?=\n|$)/gi),
  ];
  const first = headings[0];
  const firstRow = formula.columns[0]?.rows[0]?.name;
  if (headings.length !== 1 || !first || !firstRow) {
    return [];
  }
  if (/\bDrug\s+Facts/i.test(first[0]) && !formula.drugFacts) {
    return [];
  }
  const start = first.index + range.start;
  const end = start + first[0].length;
  return end <= firstRow.start ? [{ start, end }] : [];
}
