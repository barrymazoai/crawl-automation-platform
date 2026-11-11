import {
  isIngredientHeading,
  readsCompositionRules,
  type LabelFormatId,
  type LabelTextCandidate,
} from "@crawl-automation/v3-contracts";
import type { TranscriptRow } from "../transcript/html-transcript.js";
import { readsComposition } from "../../text/protocol/composition-clause.js";
import { isAmountCell } from "../transcript/transcript-cells.js";
import type { LabelTranscriptWire } from "../../vision/protocol/label-transcript-wire.js";

/**
 * Owner 2026-11-07 (KAN-243, the 21 amazon.in Reviews of the full rerun): an Indian composition ("Each 5 gm Contains:")
 * ends with what the product is made up with, not dosed actives: "Excipients q.s.", "Preservative: Sodium Benzoate IP",
 * "Colour: Sunset Yellow FCF", "In a flavoured sugar free syrup base q.s." (Softovac SF, Kapiva Shilajit Gold Resin,
 * D3 Must 60K syrup, Dabur Shatavari, Sea Buckthorn juice). Printed inside the composition, those lines are no
 * formula rows; the label prints no separate Other Ingredients section.
 */
const COMPOSITION = /\beach\b[^:]{0,60}?\bcontains?\b|\bcomposition\b/i;
const MADE_UP_WITH =
  /^(?:other\s+)?(?:excipients?|preservatives?|colou?rs?|flavou?r(?:ing)?s?|sweeteners?|stabili[sz]ers?|thickeners?|binders?|diluents?|anti-?caking\s+agents?|glazing\s+agents?)\b|^permitted\b/i;
const BASE = /\bbase\b/i;
const QS = /^q\.?\s*s\.?$/i;

/** An answer retained in the first India formats (2026-11-06) decodes exactly as it was read. */
const current = readsCompositionRules;

interface PanelLines {
  heading: string | null;
  servingLines: readonly string[];
}

/** The panel prints a composition: its heading or an "Each … contains:" line says so. */
function printsComposition(panel: PanelLines): boolean {
  return [panel.heading ?? "", ...panel.servingLines].some((line) => COMPOSITION.test(line));
}

const values = (row: TranscriptRow) => row.cells.slice(1).map((cell) => cell.trim());
const dosed = (row: TranscriptRow) => values(row).some(isAmountCell);

/** A line that opens what the product is made up with: its name says so, or its amount is "q.s.". */
function madeUpWith(row: TranscriptRow): boolean {
  const name = (row.cells[0] ?? "").trim();
  const printed = values(row).filter(Boolean);
  if (printed.some((value) => QS.test(value))) {
    return true;
  }
  return MADE_UP_WITH.test(name) || (BASE.test(name) && !printed.some(isAmountCell));
}

/**
 * The composition's rows without the lines the product is made up with: each such line, and the undosed lines under
 * it ("Preservative" then "Sodium Benzoate IP"). A dosed active after them is kept. Any other panel is unchanged.
 */
export function compositionRows(
  panel: PanelLines,
  rows: TranscriptRow[],
  formats: readonly LabelFormatId[],
): TranscriptRow[] {
  if (!current(formats) || !printsComposition(panel)) {
    return rows;
  }
  let under = false;
  return rows.filter((row) => {
    if (madeUpWith(row)) {
      under = true;
      return false;
    }
    if (under && !dosed(row)) {
      return false;
    }
    under = false;
    return true;
  });
}

/**
 * A copied "ingredients" section headed "Preservatives:" or "Other excipients:" (Shatavari, Sea Buckthorn) is the
 * composition's made-up-with line, not an Other Ingredients list: no list is read from it, as when none is in view.
 */
export function compositionWire(
  wire: LabelTranscriptWire,
  formats: readonly LabelFormatId[],
): LabelTranscriptWire {
  const heading = wire.otherIngredientsHeading?.trim() ?? "";
  if (
    !current(formats) ||
    !heading ||
    isIngredientHeading(heading) ||
    !MADE_UP_WITH.test(heading)
  ) {
    return wire;
  }
  return {
    ...wire,
    otherIngredientsHeading: null,
    otherIngredients: null,
    otherIngredientsState: "not_fully_visible",
  };
}

/**
 * A page's composition read with its made-up-with lines as the last rows ("Colours: Black Oxide of Iron, Red Oxide of
 * Iron …" after Supradyn's trace elements; "Permitted class II preservatives less than 0.3%" after Krishna's juice):
 * those last rows leave the formula. Their quotes stay placed, so the page text is still covered.
 */
export function compositionTextRows(
  candidate: LabelTextCandidate,
  formats: readonly LabelFormatId[],
): void {
  if (!current(formats)) {
    return;
  }
  withoutNumberList(candidate);
  if (readsComposition(candidate)) {
    withoutMadeUpSection(candidate);
    (candidate.formula?.columns ?? []).forEach(withoutMadeUpRows);
  }
}

/** The made-up-with lines read as the ingredient section ("Colours: Black Oxide of Iron, …", Supradyn-like tablets). */
function withoutMadeUpSection(candidate: LabelTextCandidate): void {
  const heading = candidate.otherIngredients?.heading.text.trim() ?? "";
  if (heading && !isIngredientHeading(heading) && MADE_UP_WITH.test(heading)) {
    candidate.otherIngredients = null;
  }
}

type TextColumn = NonNullable<LabelTextCandidate["formula"]>["columns"][number];

/** The made-up-with lines read as the column's last rows. */
function withoutMadeUpRows(column: TextColumn): void {
  const start = column.rows.findIndex(
    (row) => QS.test(row.amount?.text.trim() ?? "") || MADE_UP_WITH.test(row.name.text.trim()),
  );
  const tail = start < 0 ? [] : column.rows.slice(start + 1);
  if (start > 0 && tail.every((row) => !row.amount || MADE_UP_WITH.test(row.name.text.trim()))) {
    column.rows = column.rows.slice(0, start);
  }
}

/**
 * A page's ingredients field holding only a number (Dabur Jamun Neem Karela juice: "Ingredients: 1") lists no
 * ingredient: no list is read from it.
 */
function withoutNumberList(candidate: LabelTextCandidate): void {
  const items = candidate.otherIngredients?.items ?? [];
  if (items.length && items.every((item) => !/\p{L}/u.test(item.text))) {
    candidate.otherIngredients = null;
    candidate.ingredientsComplete = false;
  }
}
