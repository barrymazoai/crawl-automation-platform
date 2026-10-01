const DV_BASIS = new RegExp(
  String.raw`(?:(?:percent|%)\s*daily\s+values?|%dv)\s+(?:\(%?dv\)\s+)?(?:are\s+)?` +
    String.raw`based\s+(?:on|upon)\s+(?:a\s+)?2,?000[\s-]+calorie\s+diet`,
  "i",
);
const DV_NOT_ESTABLISHED = new RegExp(
  String.raw`(?:(?:percent|%)\s*)?daily\s+values?(?:\s*\(%?dv\))?\s+` +
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
// Accept one to three complete DV sentences; a recognized prefix cannot hide other label text.
export const DV_SENTENCE = String.raw`[*+⁺†‡§¶\s]*(?:;\s*)?(?:${DV_BASIS.source}|${DV_NOT_ESTABLISHED.source}|${DV_NEEDS.source}|${DV_TELLS.source})\.?`;
export const STANDARD_FOOTNOTE = new RegExp(`^(?:${DV_SENTENCE}){1,3}$`, "i");
