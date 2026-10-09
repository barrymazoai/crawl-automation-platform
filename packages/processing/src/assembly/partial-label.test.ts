import { describe, expect, it } from "vitest";
import { labelCandidate } from "../testing/assembly-fixture.js";
import { partialLabelConflicts } from "./partial-label.js";

/** A copy of the fixture whose other ingredients read `items`. */
function withIngredients(items: string[], complete: boolean) {
  const candidate = labelCandidate();
  if (!candidate.otherIngredients) {
    throw new Error("Fixture requires other ingredients");
  }
  candidate.otherIngredients.items = items.map((text) => ({ text, evidence: text }));
  candidate.ingredientsComplete = complete;
  return candidate;
}

describe("partial label ingredients (owner 2026-10-09, CRAWLV3-214)", () => {
  const parts = { formula: false, ingredients: true };

  it("does not call a wording-only difference a conflict", () => {
    const partial = withIngredients(["DRY ROASTED ALMONDS."], true);
    const complete = withIngredients(["Dry Roasted Almonds"], true);
    expect(partialLabelConflicts(partial, complete, parts)).toEqual([]);
  });

  it("still reports different ingredients", () => {
    const partial = withIngredients(["Cashews"], true);
    const complete = withIngredients(["Dry Roasted Almonds"], true);
    expect(partialLabelConflicts(partial, complete, parts)).toEqual([
      "LABEL_PRODUCT.INGREDIENTS_CONFLICT",
    ]);
  });
});
