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
];
const footnotes = [
  "Percent Daily Values are based on a 2,000 calorie diet.",
  "Percent Daily Values (DV) based upon a 2,000 calorie diet.",
  "Percent Daily Value based on a 2,000 calorie diet.",
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
  ] satisfies [Reason, string][])("still refuses %s: %j", (reason, text) => {
    expect(checkExclusion(text, reason)).toEqual(["LABEL.COVERAGE_UNCERTAIN"]);
  });
});
