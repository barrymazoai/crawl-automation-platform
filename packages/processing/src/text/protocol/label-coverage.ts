import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { uncoveredSpans } from "./coverage.js";
import type { Span } from "./evidence-lines.js";
import { ingredientGap } from "./ingredient-boundaries.js";
import { STANDARD_FOOTNOTE } from "./label-footnotes.js";
import { anchoredHeadings } from "./label-headings.js";

const COLUMN_LABEL = /(?:Amt\s+Per\s+Serving\s*:|%\s*Daily\s+Value\s*:)/gi;
const PARAGRAPH_TAG = /<\/?p>/gi;
const EQUIVALENT =
  /^\(\s*(?:extract\s+)?(?:equivalent\s+to|equiv\.{1,2})\s+[^()\n]*?\b\d+(?:\.\d+)?\s*(?:mcg|mg|g|iu)\s*\)$/i;

/** Derive coverage only from located fields; never infer another row, dose or ingredient. */
export function labelCoverage(
  candidate: LabelTextCandidate,
  source: { text: string; range: Span },
  placed: readonly Span[],
): Span[] {
  const { text, range } = source;
  const derived = [...anchoredHeadings(candidate, text, range), ...paragraphTags(text, range)];
  const items = candidate.otherIngredients?.items ?? [];
  items.forEach((item, index) => {
    const previous = items[index - 1];
    const gap = previous && ingredientGap(text, previous, item);
    if (gap) {
      derived.push(gap);
    }
  });
  const covered = [...placed, ...derived];
  if (candidate.formula) {
    covered.push(...columnLabels(candidate.formula, text));
    for (const gap of uncoveredSpans(range, covered)) {
      const value = text.slice(gap.start, gap.end).trim();
      if (STANDARD_FOOTNOTE.test(value) || ROW_CONNECTOR.test(value)) {
        covered.push(gap);
      }
    }
  }
  return covered;
}

function paragraphTags(text: string, range: Span): Span[] {
  return [...text.slice(range.start, range.end).matchAll(PARAGRAPH_TAG)].map((match) => {
    const start = range.start + (match.index ?? 0);
    return { start, end: start + match[0].length };
  });
}

function columnLabels(formula: NonNullable<LabelTextCandidate["formula"]>, text: string): Span[] {
  const fields = formula.columns.flatMap((column) =>
    column.rows.flatMap((row) => [row.name, row.amount, row.dailyValue].filter((field) => !!field)),
  );
  const first = Math.min(...fields.map((field) => field.start));
  const last = Math.max(...fields.map((field) => field.end));
  return [...text.slice(first, last).matchAll(COLUMN_LABEL)].map((match) => {
    const start = first + (match.index ?? 0);
    return { start, end: start + match[0].length };
  });
}

/** A dose-related parenthesis is a warning only when it directly follows its cited row or earlier cited equivalents. */
export function equivalentFootnoteAllowed(
  exclusion: LabelTextCandidate["exclusions"][number],
  candidate: LabelTextCandidate,
  text: string,
): boolean {
  if (exclusion.reason !== "footnote" || !EQUIVALENT.test(exclusion.quote.text.trim())) {
    return false;
  }
  const rows = candidate.formula?.columns.flatMap((column) => column.rows) ?? [];
  const before = rows
    .map((row) => Math.max(row.name.end, row.amount?.end ?? 0, row.dailyValue?.end ?? 0))
    .filter((end) => end <= exclusion.quote.start);
  const end = Math.max(...before);
  if (
    !Number.isFinite(end) ||
    rows.some((row) => row.name.start > end && row.name.start < exclusion.quote.end)
  ) {
    return false;
  }
  let cursor = end;
  for (const prior of candidate.exclusions
    .filter((item) => item.quote.start >= end && item.quote.end <= exclusion.quote.start)
    .sort((left, right) => left.quote.start - right.quote.start)) {
    if (
      !/^\s*$/.test(text.slice(cursor, prior.quote.start)) ||
      !EQUIVALENT.test(prior.quote.text.trim())
    ) {
      return false;
    }
    cursor = prior.quote.end;
  }
  return /^\s*$/.test(text.slice(cursor, exclusion.quote.start));
}

/**
 * The FDA Nutrition Facts wording "Total Sugars 0 g, including 0 g Added Sugars": the connector between two quoted
 * rows carries no value (bloodsugarfriendly.com 2026-10-21, Review TEXT.LABEL_EXTRACTION_INCOMPLETE).
 */
const ROW_CONNECTOR = /^[,;:\s]*(?:including|includes)[,;:\s]*$/iu;
