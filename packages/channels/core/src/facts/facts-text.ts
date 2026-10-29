import { factsErrors } from "./facts-errors.js";
import type { FactsText } from "../adapter.js";
import { pageText } from "../page-text.js";

/**
 * Whether a product page's own Supplement Facts text is complete enough to be the only formula source, so the product
 * needs no image download, OCR or vision (text-facts-first/1). Required: a serving size, at least one ingredient
 * amount other than calories, and a non-empty Other Ingredients list. Anything missing keeps the images.
 */
const AMOUNT =
  /\b\d[\d,]*(?:\.\d+)?\s*(?:mg|mcg|µg|μg|g|kg|iu|cfu|billion|million|ml|kcal)\b|\b\d[\d,]*(?:\.\d+)?\s*%/gi;

const FACTS_HEADING = /\b(?:Supplement|Nutrition|Drug)\s+Facts\b/i;
/** The serving's own weight ("Serving Size: 1 Scoop (10.8g)") is not an ingredient amount. */
const SERVING_SIZE_VALUE =
  /\bServing\s+Size\s*:?\s*(?:\d[\d.,/]*\s*[^\s\d(]*\s*)?(?:\([^)\n]{0,40}\))?/gi;

/**
 * Ingredient amounts count only from the Facts heading on. EarthNutri (2026-10-26) printed a Facts heading with only
 * its serving lines and Other Ingredients, the rows were in an image, and "TeaCrine 250mg" in the marketing above
 * made the text look complete, so no image was read. Rows may follow Other Ingredients (EarthNutri's feature chart).
 */
function panelText(text: string): string {
  const heading = FACTS_HEADING.exec(text);
  return heading ? text.slice(heading.index) : text;
}

/**
 * Medical formula / food tables: Kate Farms Pediatric Peptide 1.0 prints "Nutrition Info", a
 * "Composition | Amount" header and six quantified rows, but no Serving Size line in that tab.
 * Require two actual rows so a marketing heading and two summary badges cannot masquerade as a panel.
 */
export function nutritionInfoTableText(text: string | null): boolean {
  if (!text) {
    return false;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.some((line) =>
    /^(?:nutrition\s+info|nutrition(?:al)?\s+information)\s*:?$/i.test(line),
  );
  const columns = lines.some((line) =>
    /^(?:composition\s*\t\s*amount|nutrient\s*\t\s*per\s+serving)\s*:?$/i.test(line),
  );
  const row = /^[A-Za-z][^\n\t]*?(?:\t|\s)\s*\d[\d,.]*\s*(?:kcal|g|mg|mcg|[µμ]g|iu)\b/i;
  return (heading || columns) && lines.filter((line) => row.test(line)).length >= 2;
}

/** Decoded one after another, in this order, exactly as the planner always did (so decisions stay the same). */
const ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/&nbsp;/g, " "],
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
];

/** The facts HTML as one plain-text block: scripts and tags removed, line breaks kept, entities decoded. */
export function factsTextFromHtml(html: string): string {
  const tagless = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = ENTITIES.reduce((text, [entity, value]) => text.replace(entity, value), tagless);
  return decoded.replace(/[ \t]+/g, " ").trim();
}

export interface FactsVerdict {
  complete: boolean;
  reasons: string[];
  amounts: number;
}

/** The completeness rule itself; `reasons` names every missing part (FACTS.*). */
export function factsTextComplete(text: string | null): FactsVerdict {
  if (!text?.trim()) {
    return { complete: false, reasons: [factsErrors.code("FACTS.TEXT_MISSING")], amounts: 0 };
  }
  const reasons: string[] = [];
  const nutritionTable = nutritionInfoTableText(text);
  if (!nutritionTable && !/Serving Size/i.test(text)) {
    reasons.push(factsErrors.code("FACTS.SERVING_SIZE_MISSING"));
  }
  // Calories carry no unit and do not count; "% Daily Value" headings carry no number and do not match.
  const amounts = (panelText(text).replace(SERVING_SIZE_VALUE, " ").match(AMOUNT) ?? []).length;
  if (!amounts) {
    reasons.push(factsErrors.code("FACTS.AMOUNTS_MISSING"));
  }
  if (
    !/Other Ingredients\s*:?\s*[A-Za-z(]/i.test(text) &&
    !(nutritionTable && /\bIngredients\s*:\s*[A-Za-z(]/i.test(text))
  ) {
    reasons.push(factsErrors.code("FACTS.OTHER_INGREDIENTS_MISSING"));
  }
  return { complete: reasons.length === 0, reasons, amounts };
}

/** The shared facts judgement from facts HTML: the plain text and whether it alone can give the formula. */
export function factsFromHtml(html: string | null): FactsText {
  const structured = html ? pageText(html, { rowCells: true }) : null;
  const text = html
    ? (nutritionInfoTableText(structured) ? structured : factsTextFromHtml(html)) || null
    : null;
  const verdict = factsTextComplete(text);
  return { text, complete: verdict.complete, missing: verdict.reasons };
}
