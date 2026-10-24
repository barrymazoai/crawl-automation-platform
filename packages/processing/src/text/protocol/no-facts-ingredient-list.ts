import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { completeIngredientItem, ingredientGap } from "./ingredient-boundaries.js";

type Quote = { text: string; start: number; end: number };
type Column = NonNullable<LabelTextCandidate["formula"]>["columns"][number];
type Other = NonNullable<LabelTextCandidate["otherIngredients"]>;
const FACTS_HEADING =
  /^\s*(?:(?:Supplement|Nutrition|Drug)\s+Facts|Nutrition(?:al)?\s+(?:Info|Information)|Amount\s+Per\s+Serving(?:\s+%\s+Daily\s+Value)?)\s*:?\s*$/imu;
const SERVING_LINE = /^\s*Servings?\s+(?:Size|Per\s+Container)\b/imu;
const PRINTED_DOSE = /\b\d+(?:[.,]\d+)?\s*(?:mcg|µg|mg|g|kg|iu|cfu|ml)\b|\b\d+(?:[.,]\d+)?\s*%/iu;

/** A supplied range with no panel heading, serving line, or answered printed row dose/DV. */
export function noFactsEvidence(
  candidate: LabelTextCandidate,
  text: string,
  range: { start: number; end: number },
): boolean {
  const source = text.slice(range.start, range.end);
  if (FACTS_HEADING.test(source) || SERVING_LINE.test(source)) {
    return false;
  }
  const formula = candidate.formula;
  if (!formula) {
    return true;
  }
  return (
    !formula.drugFacts &&
    !formula.servingSize &&
    !formula.servingsPerContainer &&
    !formula.columns.some((column) => column.rows.some(printedRowDose))
  );
}

function printedRowDose(row: Column["rows"][number]): boolean {
  return (
    row.amount !== null ||
    row.dailyValue !== null ||
    row.amountStatus === "printed" ||
    PRINTED_DOSE.test(row.name.text)
  );
}

/** Treat a fully cited Ingredients list as ingredients, regardless of undosed false formula rows elsewhere on the page. */
export function normalizeNoFactsIngredientList(
  candidate: LabelTextCandidate,
  text: string,
  range: { start: number; end: number },
): void {
  if (!noFactsEvidence(candidate, text, range)) {
    return;
  }
  const formula = candidate.formula;
  const column = formula?.columns.length === 1 ? formula.columns[0] : undefined;
  if (!column || !undosedRows(column)) {
    return;
  }
  const other = citedList(candidate, column, { text, range });
  if (!other || !column.rows.every((row) => rowBelongsToList(row.name, other, text))) {
    return;
  }

  reclassify(candidate, other);
}

function undosedRows(column: Column): boolean {
  return (
    (!column.heading || /^Ingredients\s*:?$/iu.test(column.heading.text.trim())) &&
    column.rows.length > 0 &&
    column.rows.every(
      (row) =>
        row.kind === "nutrient" &&
        row.parentRowIndex === null &&
        !row.purpose &&
        (row.amountStatus === "not_declared" || row.amountStatus === "not_applicable"),
    )
  );
}

function citedList(
  candidate: LabelTextCandidate,
  column: Column,
  source: { text: string; range: { start: number; end: number } },
): Other | null {
  if (candidate.otherIngredients && !candidate.ingredientsComplete) {
    return null;
  }
  const other =
    candidate.otherIngredients ??
    (column.heading
      ? { heading: column.heading, items: column.rows.map((row) => row.name) }
      : null);
  if (!other || !/^Ingredients\s*:?$/iu.test(other.heading.text.trim())) {
    return null;
  }
  const first = other.items[0];
  if (!first) {
    return null;
  }
  // A second consecutive Ingredients heading is page structure, not a formula row.
  const duplicate = secondHeading(other.heading, first, source.text);
  const nearest = duplicate ? { ...other, heading: duplicate } : other;
  return completeList(nearest, source.text, source.range) ? nearest : null;
}

function rowBelongsToList(name: Quote, other: Other, text: string): boolean {
  const last = other.items.at(-1);
  if (!last) {
    return false;
  }
  const inList = other.items.some((item) => item.start === name.start && item.end === name.end);
  const listHeading = name.start === other.heading.start && name.end === other.heading.end;
  const outside =
    (name.end <= other.heading.start || name.start >= last.end) &&
    (wholeLine(text, name) || titleLine(text, name));
  return inList || listHeading || outside;
}

function reclassify(candidate: LabelTextCandidate, other: Other): void {
  candidate.formula = null;
  candidate.otherIngredients = other;
  candidate.formulaComplete = false;
  candidate.ingredientsComplete = true;
  candidate.issues = candidate.issues.filter((issue) => issue.code !== "INGREDIENTS_MISSING");
  candidate.ingredientParagraphReclassified = true;
}

/** A commerce footnote ahead of a no-Facts list is page chrome, not an ingredient legend. */
export function noFactsCommerceNote(
  candidate: LabelTextCandidate,
  text: string,
  exclusion: LabelTextCandidate["exclusions"][number],
): boolean {
  const heading = candidate.otherIngredients?.heading;
  return (
    !!heading &&
    exclusion.quote.end <= heading.start &&
    /^\*Not valid for distributor orders\.?$/iu.test(exclusion.quote.text.trim()) &&
    ["metadata", "marketing", "noise"].includes(exclusion.reason) &&
    noFactsEvidence(candidate, text, { start: 0, end: text.length })
  );
}

/** This printed marker may follow the last cited item without naming another ingredient. */
export function noFactsCertifiedMarker(
  candidate: LabelTextCandidate,
  text: string,
  value: string,
): string | null {
  const marker = /^([*†‡])\s*certified\s+organic\.?$/iu.exec(value)?.[1];
  return marker && noFactsEvidence(candidate, text, { start: 0, end: text.length }) ? marker : null;
}

function secondHeading(heading: Quote, first: Quote, text: string): Quote | null {
  const gap = text.slice(heading.end, first.start);
  const match = /^\s*(Ingredients)\s*$/iu.exec(gap);
  const label = match?.[1];
  if (!label) {
    return null;
  }
  const start = heading.end + gap.indexOf(label);
  return { text: label, start, end: start + label.length };
}

function completeList(other: Other, text: string, range: { start: number; end: number }): boolean {
  const { heading, items } = other;
  const first = items[0],
    last = items.at(-1);
  if (!first || !last) {
    return false;
  }
  if (
    heading.start < range.start ||
    last.end > range.end ||
    !/^\s*:?\s*$/u.test(text.slice(heading.end, first.start))
  ) {
    return false;
  }
  if (!listItemsAreCited(items, text)) {
    return false;
  }
  // The last citation must reach the end of its printed list line; no uncited trailing item can be dropped.
  return /^\s*\.?\s*$/u.test(text.slice(last.end).split(/\r?\n/u, 1)[0] ?? "");
}

function listItemsAreCited(items: Other["items"], text: string): boolean {
  for (const [index, item] of items.entries()) {
    if (
      text.slice(item.start, item.end) !== item.text ||
      !completeIngredientItem(item.text, items.length > 1)
    ) {
      return false;
    }
    const previous = items[index - 1];
    if (previous && !ingredientGap(text, previous, item)) {
      return false;
    }
  }
  return true;
}

function wholeLine(text: string, quote: Quote): boolean {
  const start = text.lastIndexOf("\n", quote.start - 1) + 1;
  const lineEnd = text.indexOf("\n", quote.end);
  const end = lineEnd < 0 ? text.length : lineEnd;
  return /^\s*$/u.test(text.slice(start, quote.start)) && /^\s*$/u.test(text.slice(quote.end, end));
}

function titleLine(text: string, quote: Quote): boolean {
  const start = text.lastIndexOf("\n", quote.start - 1) + 1;
  const lineEnd = text.indexOf("\n", quote.end);
  const end = lineEnd < 0 ? text.length : lineEnd;
  return (
    /^\s*$/u.test(text.slice(start, quote.start)) &&
    /\bFormula$/iu.test(quote.text.trim()) &&
    /^\t\S/u.test(text.slice(quote.end, end))
  );
}
