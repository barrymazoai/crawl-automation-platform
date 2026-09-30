import { describe, expect, it } from "vitest";
import { isAllowedAnchoredExclusion } from "./anchored-exclusions.js";

describe("isAllowedAnchoredExclusion", () => {
  it.each([
    ["heading", " Supplement Facts ", true],
    ["heading", "Amount Per Serving % Daily Value", true],
    ["heading", "Servings Per Container: 30", true],
    ["heading", "Oher Ingredients:", true],
    ["heading", "Vitamin C", false],
    ["heading", "Other Ingredients: Rice flour", false],
    ["directions", "Suggested Use: Take one daily.", true],
    ["directions", "Directions: Take with water.", true],
    ["directions", "Directions: Supplement Facts Vitamin C", false],
    ["directions", "Directions: Other Ingredients: Rice flour", false],
    ["directions", "Take one daily.", false],
    ["footnote", "† Daily Value not established.", true],
    ["footnote", "* Percent Daily Values are based on a diet.", true],
    ["footnote", "^ Naturally occurring", true],
    ["footnote", "Vitamin C 100 mg", false],
    ["allergen", "Contains: Milk", true],
    ["allergen", "Manufactured on shared equipment.", true],
    ["allergen", "Processed in a facility.", true],
    ["allergen", "May contain soy.", true],
    ["allergen", "Milk powder", false],
    ["marketing", "Natural health support", false],
    ["noise", "123", false],
    ["unknown", "Supplement Facts", false],
  ])("%s accepts %j only when safe=%s", (reason, text, allowed) => {
    const quote = { text, start: 0, end: text.length };
    expect(isAllowedAnchoredExclusion(reason, quote, text)).toBe(allowed);
  });

  it.each([
    ["10 mg", "1 Scoop\n2 Scoops", true],
    ["20%†", "1 scoop / 2 scoops", true],
    ["10 mg", "1 Scoop", false],
    ["10 mg", "2 Scoops", false],
    ["Vitamin C 10 mg", "1 Scoop\n2 Scoops", false],
  ])(
    "excludes alternate amount %j only with two printed serving columns",
    (text, source, allowed) => {
      expect(
        isAllowedAnchoredExclusion(
          "alternate_serving",
          { text, start: 0, end: text.length },
          source,
        ),
      ).toBe(allowed);
    },
  );
});
