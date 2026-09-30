/**
 * Whether a product page's own Supplement Facts text is complete enough to be the only formula source, so the product
 * needs no image download, OCR or vision (text-facts-first/1). The old backend did the same for Swanson
 * (apps/backend/src/swanson/facts-html.ts: "with the HTML facts there is no OCR; if it cannot be read, the image line
 * takes over — the same split as GNC"). Required: a serving size, at least one ingredient amount other than calories,
 * and a non-empty Other Ingredients list. Anything missing keeps the images.
 */
const AMOUNT = /\b\d[\d,]*(?:\.\d+)?\s*(?:mg|mcg|µg|μg|g|kg|iu|cfu|billion|million|ml|kcal)\b|\b\d[\d,]*(?:\.\d+)?\s*%/gi;
export function factsTextFromHtml(html: string) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").trim();
}
export function factsTextComplete(text: string | null) {
  const reasons: string[] = [];
  if (!text?.trim()) return { complete: false, reasons: ["FACTS.TEXT_MISSING"], amounts: 0 };
  if (!/Serving Size/i.test(text)) reasons.push("FACTS.SERVING_SIZE_MISSING");
  // Calories carry no unit and do not count; "% Daily Value" headings carry no number and do not match.
  const amounts = (text.match(AMOUNT) ?? []).length;
  if (!amounts) reasons.push("FACTS.AMOUNTS_MISSING");
  if (!/Other Ingredients\s*:?\s*[A-Za-z(]/i.test(text)) reasons.push("FACTS.OTHER_INGREDIENTS_MISSING");
  return { complete: !reasons.length, reasons, amounts };
}
