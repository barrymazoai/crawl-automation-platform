import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { uncoveredSpans } from "./coverage.js";
import type { Span } from "./evidence-lines.js";
import { ingredientGap } from "./ingredient-boundaries.js";
import { STANDARD_FOOTNOTE } from "./label-footnotes.js";
import { anchoredHeadings } from "./label-headings.js";

/** Derive coverage only from located fields; never infer another row, dose or ingredient. */
export function labelCoverage(
  candidate: LabelTextCandidate,
  source: { text: string; range: Span },
  placed: readonly Span[],
): Span[] {
  const { text, range } = source;
  const derived = anchoredHeadings(candidate, text, range);
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
    for (const gap of uncoveredSpans(range, covered)) {
      const value = text.slice(gap.start, gap.end).trim();
      if (STANDARD_FOOTNOTE.test(value) || ROW_CONNECTOR.test(value)) {
        covered.push(gap);
      }
    }
  }
  return covered;
}

/**
 * The FDA Nutrition Facts wording "Total Sugars 0 g, including 0 g Added Sugars": the connector between two quoted
 * rows carries no value (bloodsugarfriendly.com 2026-10-21, Review TEXT.LABEL_EXTRACTION_INCOMPLETE).
 */
const ROW_CONNECTOR = /^[,;:\s]*(?:including|includes)[,;:\s]*$/iu;
