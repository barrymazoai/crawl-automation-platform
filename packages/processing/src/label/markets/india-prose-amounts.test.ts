import { describe, expect, it } from "vitest";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { proseAmounts } from "./india-prose-amounts.js";

/** Kapiva Shilajit Gold Resin (amazon.in B0BL3TN1QC, 2026-11-07): the composition printed as one paragraph. */
const lines = [
  "Ingredients : Each 1g contains: Shilajit (Asphaltum) Exd. 333.33mg,",
  "Coffee Extract (Coffea arabica) Sd. 200mg, Ashwagandha Extract",
  "(Withania somnifera) Rt. 133.33mg, Gokshura Extract (Tribulus",
  "terrestris) Fr. 77.92mg, Haldi Extract (Curcuma longa) Rz. 50mg, Black",
].map((text) => ({ text }));

const INDIA = ["us-facts/1", "in-nutritional-information/2", "in-composition/2"] as const;

const candidate = (rows: [string, string][]) =>
  ({
    formula: {
      columns: [
        {
          rows: rows.map(([name, amount]) => ({
            name: { text: name, evidence: name },
            amount: { text: amount, evidence: amount },
          })),
        },
      ],
    },
  }) as unknown as LabelImageCandidate;

describe("India: amounts of a composition printed as a paragraph", () => {
  it("are confirmed where the first dose after each name is that amount", () => {
    const read = candidate([
      ["Shilajit (Asphaltum) Exd.", "333.33mg"],
      ["Coffee Extract (Coffea arabica) Sd.", "200mg"],
      ["Ashwagandha Extract (Withania somnifera) Rt.", "133.33mg"],
      ["Gokshura Extract (Tribulus terrestris) Fr.", "77.92mg"],
    ]);
    const positions = proseAmounts(
      read,
      { text: "", lines },
      { positions: { confirmed: [0], misplaced: [1, 2] }, formats: INDIA },
    );
    expect(positions).toEqual({ confirmed: [0, 1, 2, 3], misplaced: [] });
  });

  it("are not confirmed when the copy moved an amount to another ingredient", () => {
    const read = candidate([
      ["Coffee Extract (Coffea arabica) Sd.", "133.33mg"],
      ["Ashwagandha Extract (Withania somnifera) Rt.", "200mg"],
    ]);
    const positions = proseAmounts(
      read,
      { text: "", lines },
      { positions: { confirmed: [], misplaced: [0, 1] }, formats: INDIA },
    );
    expect(positions).toEqual({ confirmed: [], misplaced: [0, 1] });
  });

  it("are not confirmed from a name printed twice", () => {
    const twice = [...lines, { text: "Shilajit (Asphaltum) Exd. is purified" }];
    const read = candidate([["Shilajit (Asphaltum) Exd.", "333.33mg"]]);
    const positions = proseAmounts(
      read,
      { text: "", lines: twice },
      { positions: { confirmed: [], misplaced: [] }, formats: INDIA },
    );
    expect(positions.confirmed).toEqual([]);
  });

  it("leave a table's misplaced amount misplaced (OCR read the names, then the amounts)", () => {
    const table = [
      "Vitamin A (Retinyl Acetate)",
      "Zinc (as Zinc Gluconate)",
      "900 mcg 10 mg 20 mg",
    ];
    const read = candidate([
      ["Vitamin A (Retinyl Acetate)", "900 mcg"],
      ["Zinc (as Zinc Gluconate)", "20 mg"],
    ]);
    const ocr = { text: "", lines: table.map((text) => ({ text })) };
    // Zinc's first dose after its name is 900 mcg on the next line: not its own amount, so nothing is confirmed.
    expect(
      proseAmounts(read, ocr, { positions: { confirmed: [], misplaced: [1] }, formats: INDIA })
        .misplaced,
    ).toEqual([1]);
  });

  it("change nothing for the first India formats or a headed table column", () => {
    const read = candidate([["Coffee Extract (Coffea arabica) Sd.", "200mg"]]);
    const before = { confirmed: [], misplaced: [0] };
    const first = ["us-facts/1", "in-nutritional-information/1", "in-composition/1"] as const;
    expect(proseAmounts(read, { text: "", lines }, { positions: before, formats: first })).toBe(
      before,
    );
  });
});
