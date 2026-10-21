import { describe, expect, it } from "vitest";
import { assessLabelCandidate, completeLabelSections } from "@crawl-automation/v3-contracts";
import { decodeIngredientPresenceAnswer } from "./label-ingredient-presence.js";
import { explicitNoneWire, printed, savedPresenceAnswer } from "./ingredient-presence-fixture.js";

function observedList(body: string) {
  const wire = explicitNoneWire();
  wire.otherIngredientsState = "not_fully_visible";
  wire.wholeLabelVisible = false;
  wire.label.otherIngredients = { heading: printed("Other Ingredients"), items: [printed(body)] };
  wire.otherIngredientsBlock = printed(body);
  wire.label.ingredientsComplete = false;
  wire.label.issues = [
    {
      code: "INGREDIENTS_MISSING",
      detail:
        "The whole physical label is not visible; additional ingredient sections cannot be ruled out.",
    },
  ];
  return wire;
}

describe("closed printed Other Ingredients list", () => {
  it("keeps the list and demotes whole-label coverage to a warning", () => {
    const wire = observedList("Olive oil, Gelatin (capsule), Glycerin.");
    const result = decodeIngredientPresenceAnswer(savedPresenceAnswer(wire));
    expect(result).toMatchObject({ status: "candidate", codes: [] });
    expect(result.candidate.ingredientsComplete).toBe(true);
    expect(result.candidate.issues).toEqual([]);
    expect(result.candidate.otherIngredients?.items.map((item) => item.text)).toEqual([
      "Olive oil",
      "Gelatin (capsule)",
      "Glycerin.",
    ]);
    expect(assessLabelCandidate(result.candidate).warnings).toContainEqual(
      expect.objectContaining({ code: "LABEL.WHOLE_LABEL_NOT_VISIBLE" }),
    );
    expect(completeLabelSections(result.candidate)).toEqual(result.candidate);
  });

  it("demotes ambiguity only when it concerns the unseen rest of the package", () => {
    const wire = observedList("Rice flour, cellulose (capsule)");
    wire.label.issues = [
      {
        code: "AMBIGUOUS",
        detail: "The image does not establish coverage of the entire physical label.",
      },
    ];
    expect(decodeIngredientPresenceAnswer(savedPresenceAnswer(wire)).status).toBe("candidate");
    wire.label.issues = [
      { code: "AMBIGUOUS", detail: "The Other Ingredients body may continue beyond the crop." },
    ];
    expect(decodeIngredientPresenceAnswer(savedPresenceAnswer(wire)).status).toBe("review");
    wire.label.issues = [
      {
        code: "INGREDIENTS_MISSING",
        detail: "The full label and Other Ingredients section are not visible.",
      },
    ];
    expect(decodeIngredientPresenceAnswer(savedPresenceAnswer(wire)).status).toBe("review");
  });

  it.each([
    "BLACK PEPPER POWDER (LEMON, SILICON DIOXIDE,",
    "sodium saccharin (1.6 mg per",
    "olive oil, and",
    "olive oil, [unreadable]",
    "gelatin c… vegetable lubricant.",
  ])("keeps truncated text in Review: %s", (body) => {
    const result = decodeIngredientPresenceAnswer(savedPresenceAnswer(observedList(body)));
    expect(result.status).toBe("review");
    expect(result.candidate.ingredientsComplete).toBe(false);
  });

  it("does not treat an unreadable issue as complete even with a closing period", () => {
    const wire = observedList("Olive oil, glycerin.");
    wire.label.issues.push({ code: "UNREADABLE", detail: "Ingredients are cut off." });
    expect(decodeIngredientPresenceAnswer(savedPresenceAnswer(wire)).status).toBe("review");
  });

  it("keeps absence claims separate from visible-list acceptance", () => {
    const wire = observedList("Olive oil, glycerin.");
    wire.otherIngredientsState = "none_printed";
    expect(decodeIngredientPresenceAnswer(savedPresenceAnswer(wire)).status).toBe("review");
  });
});
