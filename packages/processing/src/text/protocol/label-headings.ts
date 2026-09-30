import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";

const HEADING = new RegExp(
  String.raw`^[*+†‡§¶\s]*(?:supplement\s+facts|nutrition\s+facts|view\s+nutrition\s+label|` +
    String.raw`serving\s+size\s*:?|servings?\s+per\s+container\s*:?)\.?$`,
  "i",
);
const COLUMN =
  String.raw`(?:ingredients?|amounts?(?:\s+per\s+serving)?|per\s+serving|` +
  String.raw`%\s*dv|dv\s*%|(?:%\s*)?daily\s+value)`;
const SYMBOLS = String.raw`[*+†‡§¶•■|/\s]`;
const TABLE_HEADING = new RegExp(
  String.raw`^${SYMBOLS}*${COLUMN}(?:${SYMBOLS}+${COLUMN})*${SYMBOLS}*\.?$`,
  "i",
);
const SERVING_HEADER = /^(Serving Size|Servings? Per Container)\s*:\s*(\S[\s\S]*)$/i;

/** Only table vocabulary, or a serving header whose complete value is already captured. */
export function labelHeadingAllowed(value: string, candidate: LabelTextCandidate): boolean {
  if (HEADING.test(value) || TABLE_HEADING.test(value)) {
    return true;
  }
  const header = SERVING_HEADER.exec(value);
  if (!header) {
    return false;
  }
  const field = /^Serving Size$/i.test(header[1] ?? "")
    ? candidate.formula?.servingSize
    : candidate.formula?.servingsPerContainer;
  const words = (text: string) => text.replace(/\s+/gu, " ").trim();
  return !!field && words(field.text) === words(header[2] ?? "");
}
