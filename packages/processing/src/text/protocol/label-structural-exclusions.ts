import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { equivalentFootnoteAllowed } from "./label-coverage.js";
import { ingredientSubheadingAllowed } from "./label-headings.js";
import { labelHeadingAllowed } from "./label-headings.js";
import { STANDARD_FOOTNOTE, labelSpecificFootnoteAllowed } from "./label-footnotes.js";
import { labelMetadataAllowed, labelNoteAllowed } from "./label-notes.js";

type Exclusion = LabelTextCandidate["exclusions"][number];

/** A subheading or equivalent note is structural only beside the ingredients or row it cites. */
export function specialStructuralExclusion(
  exclusion: Exclusion,
  candidate: LabelTextCandidate,
  text: string,
): boolean {
  if (exclusion.reason === "heading") {
    return ingredientSubheadingAllowed(exclusion.quote.text.trim(), {
      candidate,
      span: exclusion.quote,
      text,
    });
  }
  if (exclusion.reason === "noise" && exclusion.quote.text.trim().toLowerCase() === "and the") {
    const heading = candidate.otherIngredients?.heading;
    return (
      !!heading &&
      /^inactive\s+ingredients?\s+are$/i.test(heading.text.trim()) &&
      exclusion.quote.end <= heading.start &&
      /^\s*$/.test(text.slice(exclusion.quote.end, heading.start))
    );
  }
  return exclusion.reason === "footnote" && equivalentFootnoteAllowed(exclusion, candidate, text);
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
