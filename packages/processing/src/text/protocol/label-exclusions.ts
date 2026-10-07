import { STANDARD_FOOTNOTE } from "./label-footnotes.js";
import { labelNoteAllowed } from "./label-notes.js";
import { ingredientGap } from "./ingredient-boundaries.js";
import { drugExclusionAllowed } from "./drug-label.js";
import { labelHeadingAllowed } from "./label-headings.js";
import { labelValidationErrors } from "../../label/validation-errors.js";
import type { LabelTextCandidateSchema } from "@crawl-automation/v3-contracts";
import type { z } from "zod";

type Candidate = z.infer<typeof LabelTextCandidateSchema>;
type Exclusion = Candidate["exclusions"][number];
interface Judged {
  candidate: Candidate;
  text: string;
  policyVersion: string;
}

const ESTABLISHED_FOOTNOTE =
  /^[*+†]+\s*(?:percent\s+daily\s+values?|daily\s+values?)(?:\s*\(DV\))?\s+(?:not established\.?|not determined\.?)$/i;
/** Drug Facts and every later rule set (label-text/5 onward). */
const DRUG_POLICIES = ["label-text/5", "label-text/6"];
const ALLERGEN = /^(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|processed\s+(?:in|on))/i;

/** Unrecognized exclusions retain `LABEL.COVERAGE_UNCERTAIN`; marketing always stays for Review. */
export function exclusionCodes(judged: Judged): string[] {
  const uncertain = judged.candidate.exclusions.some(
    (exclusion) =>
      !exactlyPlacedExclusion(exclusion, judged) &&
      !allowedExclusion(exclusion, judged) &&
      !(
        DRUG_POLICIES.includes(judged.policyVersion) &&
        judged.candidate.formula?.drugFacts &&
        drugExclusionAllowed(exclusion, judged.text)
      ),
  );
  return uncertain ? [labelValidationErrors.code("LABEL.COVERAGE_UNCERTAIN")] : [];
}

/** label-text/4: the heading field itself, a field's printed prefix, or a DV footnote symbol. */
function exactlyPlacedExclusion(exclusion: Exclusion, judged: Judged): boolean {
  if (!["label-text/4", ...DRUG_POLICIES].includes(judged.policyVersion)) {
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

/** Label structure, not content: headings, standard footnotes and notes, list connectors, marker legends. */
function structuralExclusion(exclusion: Exclusion, judged: Judged, value: string): boolean {
  return (
    ["heading", "metadata", "footnote", "noise"].includes(exclusion.reason) &&
    (labelHeadingAllowed(value, judged.candidate) ||
      STANDARD_FOOTNOTE.test(value) ||
      labelNoteAllowed(exclusion, judged.candidate) ||
      ingredientConnector(exclusion, judged) ||
      markerLegend(exclusion, judged))
  );
}

/** Page text the model may leave out around a label, whichever of these reasons it gives (owner 2026-10-07). */
const AROUND_LABEL = new Set(["marketing", "directions", "metadata", "heading", "noise"]);

function allowedExclusion(exclusion: Exclusion, judged: Judged): boolean {
  const value = exclusion.quote.text.trim();
  if (structuralExclusion(exclusion, judged, value)) {
    return true;
  }
  if (AROUND_LABEL.has(exclusion.reason) && outsideLabel(exclusion, judged)) {
    return true;
  }
  switch (exclusion.reason) {
    case "allergen":
      return ALLERGEN.test(value);
    case "directions":
      return allowedDirections(exclusion, judged);
    case "noise":
      return /^[+•■|/]$/.test(value) || isBlendLinkingWord(exclusion, judged);
    default:
      return false;
  }
}

const LEGEND = /^([*†‡§¶#+⁺¹²³⁴⁵⁶⁷⁸⁹◇^]+)\s*([^\s*†‡§¶#+⁺¹²³⁴⁵⁶⁷⁸⁹◇^][^\n]{0,59})$/u;
const DOSE = /\d[\d,.]*\s*(?:mg|mcg|µg|μg|g|iu|cfu|ml|%|billion|million)\b/i;

/**
 * label-text/6: a short legend for a marker printed elsewhere on this label ("¹Organic", "† 2-amino ethanol
 * phosphate"). Never a dose: a legend with an amount stays for Review.
 */
function markerLegend(exclusion: Exclusion, judged: Judged): boolean {
  const legend = LEGEND.exec(exclusion.quote.text.trim());
  const marker = legend?.[1];
  if (
    exclusion.reason !== "footnote" ||
    judged.policyVersion !== "label-text/6" ||
    !marker ||
    DOSE.test(legend[2] ?? "")
  ) {
    return false;
  }
  const { start, end } = exclusion.quote;
  return (judged.text.slice(0, start) + judged.text.slice(end)).includes(marker);
}

/** label-text/3+: "consisting of" / "and" between a blend total and one of its components. */
function isBlendLinkingWord(exclusion: Exclusion, judged: Judged): boolean {
  const quote = exclusion.quote;
  if (!["label-text/3", "label-text/4", ...DRUG_POLICIES].includes(judged.policyVersion)) {
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

type Quote = { start: number; end: number };
const FOOTNOTE_MARKER = /^\s*[[(]?\s*[*†‡§¶#+⁺¹²³⁴⁵⁶⁷⁸⁹◇^]/u;

/** Every quoted part of the label itself: Facts metadata and headings, rows, and the Other Ingredients list. */
function labelQuotes(candidate: Candidate): Quote[] {
  const formula = candidate.formula;
  const quotes: (Quote | null | undefined)[] = [
    formula?.drugFacts,
    formula?.servingSize,
    formula?.servingsPerContainer,
    ...(formula?.columns ?? []).flatMap((column) => [
      column.heading,
      ...column.rows.flatMap((row) => [row.name, row.amount, row.dailyValue]),
    ]),
    candidate.otherIngredients?.heading,
    ...(candidate.otherIngredients?.items ?? []),
  ];
  return quotes.filter((quote): quote is Quote => !!quote);
}

/**
 * Owner 2026-10-07: page text around a label (a page title or panel subtitle, a product description above the Facts,
 * Suggested Use, warnings and FAQ below them) may be left out as marketing, directions, metadata or a heading, but only
 * entirely before the label's first quoted part or after its last. Anything left out inside the label still needs Review, so label content is never hidden.
 */
function outsideLabel(exclusion: Exclusion, judged: Judged): boolean {
  // A line opening with a footnote marker belongs to the label and keeps the footnote rules.
  if (judged.candidate.formula?.drugFacts || FOOTNOTE_MARKER.test(exclusion.quote.text)) {
    return false;
  }
  const quotes = labelQuotes(judged.candidate);
  if (quotes.length === 0) {
    return false;
  }
  const first = Math.min(...quotes.map((quote) => quote.start));
  const last = Math.max(...quotes.map((quote) => quote.end));
  // After the label, a line with an amount may be label content ("Supplying 300 mg"): it stays for Review, except
  // directions, whose doses ("take 2 teaspoons (10 mL)") are how to use the product.
  return (
    exclusion.quote.end <= first ||
    (exclusion.quote.start >= last &&
      (exclusion.reason === "directions" || !DOSE.test(exclusion.quote.text)))
  );
}

function allowedDirections(exclusion: Exclusion, judged: Judged): boolean {
  if (judged.candidate.formula?.drugFacts) {
    return (
      DRUG_POLICIES.includes(judged.policyVersion) && drugExclusionAllowed(exclusion, judged.text)
    );
  }
  return (
    /^(?:suggested\s+use|directions)\s*:/i.test(exclusion.quote.text.trim()) &&
    !/supplement\s+facts|other\s+ingredients/i.test(exclusion.quote.text)
  );
}

/** Only the gap between two already anchored complete ingredients can excuse a connector. */
function ingredientConnector(exclusion: Exclusion, judged: Judged): boolean {
  const items = judged.candidate.otherIngredients?.items ?? [];
  return items.some((item, index) => {
    const previous = items[index - 1];
    const gap = previous && ingredientGap(judged.text, previous, item);
    return gap && exclusion.quote.start >= gap.start && exclusion.quote.end <= gap.end;
  });
}
