import { DomUtils } from "htmlparser2";
import { allElements, cleanText, gncDocument, visibleText } from "./gnc-dom.js";

const AMOUNT =
  /^[<≤~]?\s*\d[\d,]*(?:\.\d+)?\s*(?:mg|mcg|µg|μg|g|kg|iu|cfu|billion(?:\s+cfu)?|million(?:\s+cfu)?|ml|kcal|oz|%)\b/i;
const NOT_INGREDIENT =
  /^(?:calories(?: from fat)?|serving size|servings? per container|amount per serving)$/i;

export interface GncFactsVerdict {
  complete: boolean;
  reasons: string[];
  ingredientRows: number;
}

/** Rows of 2–4 cells whose first cell names an ingredient and whose second cell starts with an amount. */
function ingredientRows(factsHtml: string): number {
  const rows = allElements(gncDocument(factsHtml)).filter((element) => element.name === "tr");
  const cells = rows.map((row) =>
    row.children
      .filter((cell) => DomUtils.isTag(cell) && (cell.name === "td" || cell.name === "th"))
      .map((cell) => cleanText(visibleText(cell)))
      .filter(Boolean),
  );
  return cells.filter(
    ([name, amount, ...rest]) =>
      name !== undefined &&
      amount !== undefined &&
      rest.length <= 2 &&
      !/^\d/.test(name) &&
      !NOT_INGREDIENT.test(name) &&
      AMOUNT.test(amount),
  ).length;
}

/**
 * Whether GNC's own Supplement Facts HTML is complete enough to be the only formula source: an HTML table, a
 * serving size, at least one ingredient row with an amount, and a non-empty Other Ingredients list (checked on real
 * pages 877080, 352114, 877130 on 2026-09-28). Anything missing keeps the images.
 */
export function gncFactsTableComplete(factsHtml: string | null): GncFactsVerdict {
  if (!factsHtml?.trim()) {
    return { complete: false, reasons: ["GNC.FACTS_DOM_MISSING"], ingredientRows: 0 };
  }
  const document = gncDocument(factsHtml);
  const body = cleanText(visibleText(document));
  const reasons: string[] = [];
  if (!allElements(document).some((element) => element.name === "table")) {
    reasons.push("GNC.FACTS_TABLE_MISSING");
  }
  if (!/Serving Size/i.test(body)) {
    reasons.push("GNC.FACTS_SERVING_SIZE_MISSING");
  }
  const rows = ingredientRows(factsHtml);
  if (!rows) {
    reasons.push("GNC.FACTS_AMOUNTS_MISSING");
  }
  if (!/Other Ingredients\s*:?\s*[A-Za-z(]/i.test(body)) {
    reasons.push("GNC.FACTS_OTHER_INGREDIENTS_MISSING");
  }
  return { complete: reasons.length === 0, reasons, ingredientRows: rows };
}
