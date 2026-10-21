import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { exclusionCodes } from "./label-exclusions.js";

type Reason = LabelTextCandidate["exclusions"][number]["reason"];
const boilerplateReasons = ["heading", "metadata", "footnote", "noise"] as const;
const headings = [
  "Supplement Facts",
  "Nutrition Facts",
  "Serving Size",
  "Serving Size:",
  "Servings Per Container",
  "Servings Per Container:",
  "Servings Per Container :",
  "Amount Per Serving",
  "Amount Per Serving % Daily Value",
  "% Daily Value",
  "%DV",
  "% DV",
  "Daily Value",
  "View Nutrition Label",
  "Serving Per Container",
  "Amounts Per Serving",
  "Amount",
  "Ingredient",
  "DV % *",
  "DV %",
  "% DV†",
  "% Daily Value*",
  "Daily Value ‡",
  "Ingredient Amount DV % *",
  "Ingredient\n\nAmount\n\nDV % *",
  "Ingredient | Amount Per Serving | % DV*",
  "Per Serving",
];
const footnotes = [
  // 2026-09-30 real answer: the long Nutrition Facts footnote.
  "*The % Daily Value (DV) tells you how much a nutrient in a serving of food contributes to a daily diet. 2,000 calories a day is used for general nutrition advice.",
  "Percent Daily Values are based on a 2,000 calorie diet.",
  "Percent Daily Values (DV) based upon a 2,000 calorie diet.",
  "Percent Daily Value based on a 2,000 calorie diet.",
  "Percent Daily Value based on 2,000 calorie diet.",
  "Percent Daily Values are based upon 2000 calorie diet.",
  "Percent Daily Values based upon a 2,000 calorie diet.",
  "† Daily Value not established.",
  "*Daily value not established.",
  "†Daily Value not established",
  "† % Daily Value (%DV) not established.",
  "† % Daily Value not established.",
  "† Percent Daily Value (DV) not established",
  "Percent Daily Values are based on a 2,000 calorie diet.† Daily Value not established",
  "Percent Daily Values are based on a 2,000 calorie diet. †Daily Value not established",
  "†Daily Value not established Percent Daily Values are based upon a 2,000 calorie diet.",
  "Percent Daily Values (DV) are based upon a 2000 calorie diet",
  "Daily Values not determined",
  "Percent Daily Values (%DV) not determined.",
  "% Daily Value (DV) not established",
  "Daily Value not established.Percent Daily Value based on a 2,000 calorie diet",
  "Daily Value not established†Percent Daily Value based on a 2,000 calorie diet",
];
const otherText = [
  "Great taste, every day",
  "†HPF Proprietary Red Yeast Rice",
  "†Ingredient is a registered trademark.",
  "Made in USA",
  "Unknown label text",
  "Serving Size: 2 capsules",
  "Servings Per Container: 60",
  "Supplement Facts Vitamin C",
  "Ingredient Vitamin C",
  "Amount 100 mg",
  "DV % 50%",
  "Daily Value not known",
  "Ingredient Amount DV % * Caffeine",
  "Show more",
  "Percent Daily Values are based on a 2,000 calorie diet. Take 2 capsules daily.",
  "†Daily Value not established. Take 2 capsules daily.",
  "†Daily Value not established for HPF Proprietary Red Yeast Rice",
  "HPF Proprietary Red Yeast Rice. Daily Value not established.",
  "Daily Value not established. ".repeat(4).trim(),
  "Percent Daily Values are based on a 2,500 calorie diet.",
  "Daily Value not established..",
  "Daily Value not established †",
  "* + † ‡ § ¶",
];

function checkExclusion(text: string, reason: Reason): string[] {
  return exclusionCodes({
    text,
    policyVersion: "label-text/4",
    candidate: {
      codec: "label-extraction/1",
      formula: null,
      otherIngredients: null,
      formulaComplete: false,
      ingredientsComplete: false,
      issues: [],
      exclusions: [{ reason, quote: { text, start: 0, end: text.length } }],
    },
  });
}

describe.each(boilerplateReasons)("standard label boilerplate tagged %s", (reason) => {
  it.each([...headings, ...footnotes])("accepts the entire line %j", (text) => {
    expect(checkExclusion(text, reason)).toEqual([]);
    expect(checkExclusion(` \t${text.toUpperCase()} \t`, reason)).toEqual([]);
  });

  it.each(["*", "+", "†", "‡", "§", "¶", "* † ‡"])(
    "accepts leading symbols %j and optional trailing periods",
    (symbol) => {
      for (const text of [...headings, "Daily Value not established"]) {
        expect(checkExclusion(` ${symbol} ${text}. `, reason)).toEqual([]);
        expect(checkExclusion(`${symbol}${text}`, reason)).toEqual([]);
      }
    },
  );

  it.each(otherText)("refuses non-boilerplate %j", (text) => {
    expect(checkExclusion(text, reason)).toEqual(["LABEL.COVERAGE_UNCERTAIN"]);
  });
});

describe("existing exclusion rules", () => {
  it.each([...headings, ...footnotes, "Great taste, every day"])(
    "always refuses marketing, including %j",
    (text) => {
      expect(checkExclusion(text, "marketing")).toEqual(["LABEL.COVERAGE_UNCERTAIN"]);
    },
  );

  it.each([
    ["allergen", "Contains: Milk"],
    ["allergen", "May contain soy."],
    ["allergen", "Manufactured on shared equipment."],
    ["allergen", "Processed in a facility."],
    ["directions", "Suggested Use: Take one daily."],
    ["directions", "Directions: Take with water."],
    ["footnote", "†"],
    ...["+", "•", "■", "|", "/"].map((text): [Reason, string] => ["noise", text]),
    [
      "footnote",
      "*Percent Daily Values are based on a 2,000 calorie diet. Your daily values may be higher or lower depending on your calorie needs.",
    ],
  ] satisfies [Reason, string][])("still accepts %s: %j", (reason, text) => {
    expect(checkExclusion(text, reason)).toEqual([]);
  });

  it.each([
    ["allergen", "Milk powder"],
    ["allergen", "Supplement Facts"],
    ["directions", "Take 2 capsules daily."],
    ["directions", "Directions: Supplement Facts Vitamin C"],
    ["directions", "Directions: Other Ingredients: Rice flour"],
    ["directions", "Daily Value not established."],
    ["noise", "and"],
    ["noise", "consisting of"],
    ["noise", "++"],
    ["noise", "■ Vitamin C"],
  ] satisfies [Reason, string][])("still refuses %s: %j", (reason, text) => {
    expect(checkExclusion(text, reason)).toEqual(["LABEL.COVERAGE_UNCERTAIN"]);
  });
});

describe("printed label exclusions", () => {
  it.each([
    [
      "footnote",
      "*These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.",
    ],
    [
      "footnote",
      "†These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.",
    ],
    ["allergen", "CONTAINS FISH: Alaska Walleye Pollock. Tilapia"],
    ["allergen", "Contains Soy Lecithin And Gluten."],
    ["allergen", "Free from milk and soy."],
    ["marketing", "Trademark Information"],
    ["marketing", "Clear Sinus &amp; Ear® is a trademark of Clear Products, Inc.®"],
    ["metadata", "NET WT 25.40 oz (720 g)"],
    [
      "footnote",
      "Net carbs: 20 g total carbohydrate − 12 g allulose − 8 g fiber = 0 g net carbs. Allulose is excluded from Total and Added Sugars under FDA guidance (October 2020). “Net carbs” is not an FDA-defined term.",
    ],
    [
      "footnote",
      "*High protein: 20 g per bar, 40% of the Daily Value. FDA defines “high” and “excellent source of” as 20% or more of the Daily Value per reference amount customarily consumed (21 CFR 101.54(b)); protein %DV is calculated using PDCAAS per 21 CFR 101.9(c)(7).",
    ],
    ["footnote", "‡Good source of fiber, 10% of the Daily Value."],
    ["footnote", "*See 21 CFR 101.54(b) for the claim definition."],
    ["metadata", "*NATURALLY-DERIVED INGREDIENT"],
    [
      "noise",
      "Argentum Metallicum is officially approved by the Homeopathic Pharmacopoeia Convention of the United States (HPCUS) for all indications below.",
    ],
    ["metadata", "Approved by HPUS."],
  ] satisfies [Reason, string][])("accepts %s: %j", (reason, value) => {
    expect(checkExclusion(value, reason)).toEqual([]);
  });

  it.each([
    ["noise", "(2 billion viable microorganisms**)"],
    [
      "allergen",
      "Contains <2% of: Calcium Carbonate, Magnesium Silicate, Magnesium Stearate, Polyethylene Glycol, Polyvinyl Alcohol, Silicon Dioxide, Titanium Dioxide.",
    ],
    ["allergen", "Contains less than 2% of: Calcium Carbonate."],
    ["allergen", "Contains 2% or less of: Salt, Natural Flavor."],
    ["metadata", "Specifications: 100 Capsules, 500mg each"],
    ["footnote", "High protein: 20 g per bar, 40% of the Daily Value."],
    ["metadata", "NET WT 25.40 oz (720 g)\nProtein 20 g"],
  ] satisfies [Reason, string][])("refuses %s: %j", (reason, value) => {
    expect(checkExclusion(value, reason)).toEqual(["LABEL.COVERAGE_UNCERTAIN"]);
  });
});
