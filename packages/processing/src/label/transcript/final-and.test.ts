import { describe, expect, it } from "vitest";
import { splitFinalAnd } from "./final-and.js";
import { parseTranscriptRows } from "./transcript-rows.js";

const row = (...cells: string[]) => ({ cells, indent: 0, bold: false, table: 0 });

describe("an amount printed with its footnote mark (owner 2026-11-06)", () => {
  it("is the dose before the mark; the mark is the %DV column's own marker", () => {
    const [glutathione, calories] = parseTranscriptRows([
      row("L-Glutathione (reduced)", "500 mg**"),
      row("Calories", "5"),
    ]).rows;
    expect(glutathione).toMatchObject({
      amount: "500 mg",
      dailyValue: null,
      dailyValueMarker: "**",
    });
    expect(calories).toMatchObject({ amount: "5" });
    expect(calories).not.toHaveProperty("dailyValueMarker");
  });

  it("reads the same as amazon.com's copy printing the mark in a cell of its own", () => {
    const glued = parseTranscriptRows([row("Vitamin D3", "2,000 IU†")]).rows[0];
    const separate = parseTranscriptRows([row("Vitamin D3", "2,000 IU", "†")]).rows[0];
    expect(glued).toEqual(separate);
  });

  it("keeps the amount as printed when the row prints its own %DV", () => {
    const [vitamin] = parseTranscriptRows([row("Vitamin C", "60 mg*", "100%")]).rows;
    expect(vitamin).toMatchObject({ amount: "60 mg*", dailyValue: "100%" });
  });
});

describe("splitFinalAnd (owner 2026-11-06)", () => {
  it("splits the last item joining two capitalised names", () => {
    expect(
      splitFinalAnd([
        "Hypromellose (cellulose capsule)",
        "Microcrystalline Cellulose",
        "Magnesium Stearate (vegetable source) and Silicon Dioxide.",
      ]),
    ).toEqual([
      "Hypromellose (cellulose capsule)",
      "Microcrystalline Cellulose",
      "Magnesium Stearate (vegetable source)",
      "Silicon Dioxide",
    ]);
    expect(splitFinalAnd(["Sodium Chloride", "Annatto Extract and D-Biotin."])).toEqual([
      "Sodium Chloride",
      "Annatto Extract",
      "D-Biotin",
    ]);
  });

  it.each([
    [["Rice Flour", "Natural and Artificial Flavors"]],
    [["Gelatin", "Mono- and Diglycerides"]],
    [["gelatin (capsule)", "double-distilled and deionized water"]],
    [["Cellulose", "Silica and Rice Bran"]],
    [["Cellulose", "Flavourings (Artificial And Nature Identical Flavouring Substances)"]],
    [["Magnesium Stearate and Silicon Dioxide."]],
    [["Cellulose", "Sunflower Lecithin and Rice Bran and Silica"]],
  ])("keeps %j as printed", (items) => {
    expect(splitFinalAnd(items)).toEqual(items);
  });
});
