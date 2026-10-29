import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { equivalentFootnoteAllowed } from "./label-coverage.js";
import { ingredientSubheadingAllowed } from "./label-headings.js";
import { labelHeadingAllowed } from "./label-headings.js";
import { ingredientGap } from "./ingredient-boundaries.js";
import { noFactsCertifiedMarker, noFactsCommerceNote } from "./no-facts-ingredient-list.js";
import { STANDARD_FOOTNOTE, labelSpecificFootnoteAllowed } from "./label-footnotes.js";
import { labelMetadataAllowed, labelNoteAllowed } from "./label-notes.js";

type Exclusion = LabelTextCandidate["exclusions"][number];

/** A subheading or equivalent note is structural only beside the ingredients or row it cites. */
export function specialStructuralExclusion(
  exclusion: Exclusion,
  candidate: LabelTextCandidate,
  text: string,
): boolean {
  if (noFactsCommerceNote(candidate, text, exclusion)) {
    return true;
  }
  if (exclusion.reason === "heading") {
    return (
      ingredientSubheadingAllowed(exclusion.quote.text.trim(), {
        candidate,
        span: exclusion.quote,
        text,
      }) || blendSubheadingAllowed(exclusion, candidate, text)
    );
  }
  if (exclusion.reason === "marketing") {
    return ingredientOrganicLegend(exclusion, candidate, text);
  }
  if (exclusion.reason === "metadata" && productOptionLine(exclusion, candidate)) {
    return true;
  }
  if (exclusion.reason === "noise") {
    return (
      ingredientOrganicLegend(exclusion, candidate, text) ||
      inactiveConnectorAllowed(exclusion, candidate, text)
    );
  }
  return exclusion.reason === "footnote" && equivalentFootnoteAllowed(exclusion, candidate, text);
}

function inactiveConnectorAllowed(
  exclusion: Exclusion,
  candidate: LabelTextCandidate,
  text: string,
): boolean {
  const heading = candidate.otherIngredients?.heading;
  return (
    exclusion.quote.text.trim().toLowerCase() === "and the" &&
    !!heading &&
    /^inactive\s+ingredients?\s+are$/i.test(heading.text.trim()) &&
    exclusion.quote.end <= heading.start &&
    /^\s*$/.test(text.slice(exclusion.quote.end, heading.start))
  );
}

function blendSubheadingAllowed(
  exclusion: Exclusion,
  candidate: LabelTextCandidate,
  text: string,
): boolean {
  return (candidate.otherIngredients?.items ?? []).some((item, index, items) => {
    const previous = items[index - 1];
    return (
      !!previous &&
      /\b(?:blend|complex)\*?$/i.test(previous.text.trim()) &&
      /^:\s/u.test(text.slice(previous.end, exclusion.quote.start)) &&
      exclusion.quote.start >= previous.end &&
      exclusion.quote.end <= item.start &&
      ingredientGap(text, previous, { next: item, headings: [exclusion.quote] }) !== null
    );
  });
}

const PRODUCT_OPTION = /^(?:weight|flavou?r)\s*:\s*\S[^\n]{0,60}$/i;

/**
 * A store's own option line between the serving header and the first row ("Serving Size: 1 Scoop / Servings Per
 * Container: 30 / Weight: 1.33 g / Flavor: Unflavored", Aspire Nutrition 2026-10-29): it sits above every row, so it
 * cannot hide one.
 */
function productOptionLine(exclusion: Exclusion, candidate: LabelTextCandidate): boolean {
  const formula = candidate.formula;
  const header = [formula?.servingSize, formula?.servingsPerContainer].filter((field) => !!field);
  const rows = formula?.columns.flatMap((column) => column.rows) ?? [];
  return (
    PRODUCT_OPTION.test(exclusion.quote.text.trim()) &&
    header.length > 0 &&
    rows.length > 0 &&
    header.every((field) => field.end <= exclusion.quote.start) &&
    rows.every((row) => exclusion.quote.end <= row.name.start)
  );
}

/** A model may tag the printed organic marker legend as marketing or noise rather than a footnote. */
function ingredientOrganicLegend(
  exclusion: Exclusion,
  candidate: LabelTextCandidate,
  text: string,
): boolean {
  const value = exclusion.quote.text.trim();
  const ordinary = /^([*†‡])\s*organic\.?$/i.exec(value)?.[1];
  const marker = ordinary ?? noFactsCertifiedMarker(candidate, text, value);
  const items = candidate.otherIngredients?.items ?? [];
  const last = items.at(-1);
  return (
    !!marker &&
    !!last &&
    exclusion.quote.start >= last.end &&
    /^[\s.]*$/.test(text.slice(last.end, exclusion.quote.start)) &&
    items.some((item) => item.text.includes(marker))
  );
}

/** Existing text-only structural vocabulary, with no inference from neighboring items or rows. */
export function knownStructuralExclusion(
  exclusion: Exclusion,
  candidate: LabelTextCandidate,
): boolean {
  const value = exclusion.quote.text.trim();
  return (
    labelHeadingAllowed(value, candidate) ||
    STANDARD_FOOTNOTE.test(value) ||
    (exclusion.reason === "footnote" && labelSpecificFootnoteAllowed(value)) ||
    (["metadata", "noise"].includes(exclusion.reason) && labelMetadataAllowed(value)) ||
    labelNoteAllowed(exclusion, candidate)
  );
}
