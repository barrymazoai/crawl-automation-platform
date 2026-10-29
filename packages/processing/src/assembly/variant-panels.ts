import { isCompleteLabelImage, type LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { partialLabelConflicts } from "./partial-label.js";

/** One label image in the order the sources were tried. */
export interface PanelImage {
  id: string;
  candidate: LabelImageCandidate;
}

type Formula = NonNullable<LabelImageCandidate["formula"]>;

/** The shorter reading must name at least this share of the longer one's rows. */
const SHARED_ROWS = 0.8;
/**
 * Amounts a reading may print inside the row name ("Calories 70", "Includes 17g Added Sugars", "Folate 17mcg DFE"),
 * with their unit qualifiers; "B6" and "B12" keep their digits.
 */
const AMOUNT_IN_NAME =
  /\b\d[\d.,]*\s*(?:mcg|[µμ]g|mg|kg|g|iu|ml|kcal|%)?(?![\p{L}\p{N}])|\b(?:dfe|rae|ne)\b/giu;

/**
 * Owner 2026-10-29: one product's gallery may hold several Facts panels of the same formula that differ only in
 * amounts. Osmo prints one panel per flavor and packaging and none names its flavor, so no panel can be attributed
 * to a website variant. The first image's panel is used; a later image that names the same rows with other values is
 * skipped like an image without a label, since doses matter less than collecting a single product. A panel with
 * different rows (a bundle's two products, another product's panel), with an ingredient list the first one lacks, or a
 * complete label (which the merger already prefers) is kept and still conflicts. Older evidence policies are unchanged.
 */
export function variantPanelIds(
  policy: string | undefined,
  images: readonly PanelImage[],
): Set<string> {
  const skipped = new Set<string>();
  if (policy !== "label-image-first/7") {
    return skipped;
  }
  const kept: { image: PanelImage; rows: Set<string> }[] = [];
  for (const image of images) {
    const formula = image.candidate.formula;
    if (!formula) {
      continue;
    }
    const rows = rowNames(formula);
    const first = kept.find((earlier) => sameRows(earlier.rows, rows))?.image;
    if (first && otherValues(first, image)) {
      skipped.add(image.id);
    } else {
      kept.push({ image, rows });
    }
  }
  return skipped;
}

/** The later, incomplete panel disagrees with the first one's formula and adds no ingredient list of its own. */
function otherValues(first: PanelImage, later: PanelImage): boolean {
  const parts = { formula: true, ingredients: false };
  return (
    !isCompleteLabelImage({ kind: "image", candidate: later.candidate }) &&
    partialLabelConflicts(later.candidate, first.candidate, parts).length > 0 &&
    (!later.candidate.otherIngredients || !!first.candidate.otherIngredients)
  );
}

function sameRows(left: Set<string>, right: Set<string>): boolean {
  const [shorter, longer] = [left, right].sort((first, second) => first.size - second.size);
  return (
    !!shorter &&
    !!longer &&
    shorter.size > 0 &&
    shorter.size >= SHARED_ROWS * longer.size &&
    [...shorter].every((name) => longer.has(name))
  );
}

function rowNames(formula: Formula): Set<string> {
  return new Set(
    formula.columns
      .flatMap((column) => column.rows)
      .filter((row) => row.kind !== "group_header")
      .map((row) =>
        row.name.text
          .replace(AMOUNT_IN_NAME, " ")
          .replace(/\([^)]*\)/gu, " ")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, ""),
      )
      .filter(Boolean),
  );
}
