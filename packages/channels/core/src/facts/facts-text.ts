import type { FactsText } from "../adapter.js";

/**
 * Whether a product page's own Supplement Facts text is complete enough to be the only formula source, so the product
 * needs no image download, OCR or vision (text-facts-first/1). Required: a serving size, at least one ingredient
 * amount other than calories, and a non-empty Other Ingredients list. Anything missing keeps the images.
 */
const AMOUNT =
  /\b\d[\d,]*(?:\.\d+)?\s*(?:mg|mcg|µg|μg|g|kg|iu|cfu|billion|million|ml|kcal)\b|\b\d[\d,]*(?:\.\d+)?\s*%/gi;

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
    return { complete: false, reasons: ["FACTS.TEXT_MISSING"], amounts: 0 };
  }
  const reasons: string[] = [];
  if (!/Serving Size/i.test(text)) {
    reasons.push("FACTS.SERVING_SIZE_MISSING");
  }
  // Calories carry no unit and do not count; "% Daily Value" headings carry no number and do not match.
  const amounts = (text.match(AMOUNT) ?? []).length;
  if (!amounts) {
    reasons.push("FACTS.AMOUNTS_MISSING");
  }
  if (!/Other Ingredients\s*:?\s*[A-Za-z(]/i.test(text)) {
    reasons.push("FACTS.OTHER_INGREDIENTS_MISSING");
  }
  return { complete: reasons.length === 0, reasons, amounts };
}

/** The shared facts judgement from facts HTML: the plain text and whether it alone can give the formula. */
export function factsFromHtml(html: string | null): FactsText {
  const text = html ? factsTextFromHtml(html) || null : null;
  const verdict = factsTextComplete(text);
  return { text, complete: verdict.complete, missing: verdict.reasons };
}
