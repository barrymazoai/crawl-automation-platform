const ESTABLISHED_FOOTNOTE =
  /^[*+†]+\s*(?:percent\s+daily\s+values?|daily\s+values?)(?:\s*\(DV\))?\s+(?:not established\.?|not determined\.?)$/i;

/** An exactly placed DV footnote or a lone symbol printed beside its row. */
export function isDvFootnote(reason: string, value: string): boolean {
  return reason === "footnote" && (ESTABLISHED_FOOTNOTE.test(value) || /^[*+†]+$/.test(value));
}

const DV_BASIS = new RegExp(
  String.raw`(?:(?:percent(?:age)?|%)\s*daily\s+values?|%dv)\s+(?:\(%?dv\)\s+)?(?:are\s+|is\s+)?` +
    String.raw`based\s+(?:on|upon)\s+(?:a\s+)?2,?000[\s-]+calorie\s+diet`,
  "i",
);
const DV_NOT_ESTABLISHED = new RegExp(
  String.raw`(?:(?:percent(?:age)?|%)\s*)?daily\s+values?(?:\s*\(%?dv\))?\s+` +
    String.raw`not\s+(?:established|determined)`,
  "i",
);
// The long FDA form's second sentence.
const DV_NEEDS =
  /your\s+daily\s+values?\s+may\s+be\s+higher\s+or\s+lower\s+depending\s+on\s+your\s+calorie\s+needs/i;
// The long Nutrition Facts footnote: "The % Daily Value (DV) tells you how much a nutrient in a serving of food
// contributes to a daily diet. 2,000 calories a day is used for general nutrition advice."
const DV_TELLS =
  /the\s+%\s*daily\s+value\s+(?:\(dv\)\s+)?tells\s+you\s+how\s+much\s+a\s+nutrient\s+in\s+a\s+serving\s+of\s+food\s+contributes\s+to\s+a\s+daily\s+diet\.?\s*2,?000[\s-]+calories\s+a\s+day\s+(?:is|are)\s+used\s+for\s+general\s+nutrition\s+advice/i;
// The complete printed FDA disclaimer can occur on a label without a Facts panel.
export const FDA_DISCLAIMER_SENTENCE =
  /(?:These statements have|This statement has) not been evaluated by the (?:Food and Drug Administration|FDA)\.\s*This product is not intended to diagnose, treat, cure,? or prevent any disease/i;
const FDA_DISCLAIMER = new RegExp(String.raw`^[*†‡\s]*${FDA_DISCLAIMER_SENTENCE.source}\.?$`, "i");
const NET_CARBS = /^net\s+carbs?\s*:[^\n]+$/i;
const CLAIM_MARKER = /^[*†‡§¶#+⁺¹²³⁴⁵⁶⁷⁸⁹◇^][^\n]+$/iu;
const CLAIM_DAILY_VALUE = /\b(?:high|excellent\s+source|good\s+source)\b.*\bdaily\s+value\b/i;
const CLAIM_CFR = /\b21\s*CFR\b/i;

/** Complete disclaimer, net-carb calculation, or marked FDA claim note; none is a nutrient row. */
export function labelSpecificFootnoteAllowed(value: string): boolean {
  return (
    FDA_DISCLAIMER.test(value) ||
    NET_CARBS.test(value) ||
    (CLAIM_MARKER.test(value) && (CLAIM_DAILY_VALUE.test(value) || CLAIM_CFR.test(value)))
  );
}
// Accept one to three complete DV sentences; a recognized prefix cannot hide other label text.
export const DV_SENTENCE = String.raw`[*+⁺†‡§¶\s]*(?:;\s*)?(?:${DV_BASIS.source}|${DV_NOT_ESTABLISHED.source}|${DV_NEEDS.source}|${DV_TELLS.source})\.?`;
export const STANDARD_FOOTNOTE = new RegExp(`^(?:${DV_SENTENCE}){1,3}$`, "i");
