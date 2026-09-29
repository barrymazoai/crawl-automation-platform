import type { Quote } from "./evidence-lines.js";

const amountOnly = /^[\d.,\s]+(?:mcg|mg|g|iu|kcal)?\s*(?:%|\*|†|\+)*$/i;
const HEADINGS =
  /^(?:supplement\s*facts|amount\s+per\s+serving(?:\s*%\s*(?:dv|daily\s+value))?|%\s*daily\s+value|servings?\s+per\s+container\s*:?\s*\d+|(?:other|oher)\s+ingredients\s*:|[12]\s+scoops?\s*(?:%\s*(?:dv|daily\s+value)\*?)?|%\s*dv\*?)$/i;
const FOOTNOTES =
  /^(?:[*+†]\s*(?:percent\s+daily\s+values|daily\s+value|daily\s+values)|\d?\s*at\s+time\s+of\s+manufacture|\^\s*naturally\s+occurring)/i;
const ALLERGENS = /^(?:contains\s*:|manufactured\s+(?:in|on)|processed\s+(?:in|on)|may\s+contain)/i;

/** Whether text left out of an anchored answer is safely not part of the formula. */
export function isAllowedAnchoredExclusion(reason: string, quote: Quote, source: string): boolean {
  const value = quote.text.trim();
  switch (reason) {
    case "heading":
      return HEADINGS.test(value);
    case "directions":
      return (
        /^(?:suggested\s+use|directions)\s*:/i.test(value) &&
        !/supplement\s+facts|other\s+ingredients/i.test(value)
      );
    case "footnote":
      return FOOTNOTES.test(value);
    case "allergen":
      return ALLERGENS.test(value);
    case "alternate_serving":
      return amountOnly.test(value) && /1\s+scoop/i.test(source) && /2\s+scoops?/i.test(source);
    default:
      // Free-form marketing or noise is not evidence of a safe exclusion; it stays for Review.
      return false;
  }
}
