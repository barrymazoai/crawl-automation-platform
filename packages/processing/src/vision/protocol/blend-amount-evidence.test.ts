import { describe, expect, it } from "vitest";
import { defined } from "../../testing/defined.js";
import { decodeLabelImage } from "./label-vision.js";
import { decodeIngredientPresenceAnswer } from "./label-ingredient-presence.js";
import {
  explicitNoneWire,
  printed,
  savedOreganoLabel,
  savedPresenceAnswer,
} from "./ingredient-presence-fixture.js";

describe("blend totals and component amounts", () => {
  it("already accepts not_declared under a printed blend total in the old protocol", () => {
    const label = savedOreganoLabel();
    label.otherIngredients = { heading: printed("Other Ingredients"), items: [printed("water")] };
    label.ingredientsComplete = true;
    label.issues = [];
    expect(decodeLabelImage(JSON.stringify(label)).status).toBe("candidate");
  });

  it.each(["unreadable", "not_declared"] as const)(
    "requires the blend total itself to be printed (%s)",
    (amountStatus) => {
      const wire = explicitNoneWire();
      const total = defined(wire.label.formula?.columns[0]?.rows[0]);
      Object.assign(total, { amount: null, amountStatus });
      const result = decodeIngredientPresenceAnswer(savedPresenceAnswer(wire));
      expect(result.status).toBe("review");
      expect(result.codes).toContain(
        amountStatus === "unreadable" ? "LABEL.AMOUNT_UNREADABLE" : "LABEL.AMOUNT_MISSING",
      );
    },
  );

  it("keeps the B0037UM6TI group-header/unreadable evidence Review without inventing a total", () => {
    const label = savedOreganoLabel();
    const column = defined(label.formula?.columns[0]);
    column.rows = [
      {
        kind: "group_header",
        name: printed("Proprietary blend in certified organic extra virgin olive oil"),
        amount: null,
        dailyValue: null,
        amountStatus: "not_applicable",
        parentRowIndex: null,
      },
      ...[
        "Spring water",
        "Wild, raw chaga mushroom",
        "Oil of wild oregano (P73)",
        "Siberian black chaga",
        "Mycellized oregano oil",
        "Spice oil emulsion",
      ].map((text) => ({
        kind: "blend_component" as const,
        name: printed(text),
        amount: null,
        dailyValue: null,
        amountStatus: "unreadable" as const,
        parentRowIndex: 0,
      })),
    ];
    label.formulaComplete = false;
    label.issues.push({
      code: "FORMULA_MISSING",
      detail: "No amounts are printed for the blend components.",
    });
    const result = decodeLabelImage(JSON.stringify(label));
    expect(result.codes[0]).toBe("LABEL.AMOUNT_UNREADABLE");
    expect(result.codes).not.toContain("LABEL.AMOUNT_MISSING");
    column.rows.slice(1).forEach((row) => {
      row.amountStatus = "not_declared";
    });
    expect(decodeLabelImage(JSON.stringify(label)).codes).toContain("LABEL.AMOUNT_MISSING");
  });
});
