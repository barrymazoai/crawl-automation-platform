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
      { confirmed: [0], misplaced: [1, 2] },
    );
    expect(positions).toEqual({ confirmed: [0, 1, 2, 3], misplaced: [] });
  });

  it("are not confirmed when the copy moved an amount to another ingredient", () => {
    const read = candidate([
      ["Coffee Extract (Coffea arabica) Sd.", "133.33mg"],
      ["Ashwagandha Extract (Withania somnifera) Rt.", "200mg"],
    ]);
    const positions = proseAmounts(read, { text: "", lines }, { confirmed: [], misplaced: [0, 1] });
    expect(positions).toEqual({ confirmed: [], misplaced: [0, 1] });
  });

  it("are not confirmed from a name printed twice", () => {
    const twice = [...lines, { text: "Shilajit (Asphaltum) Exd. is purified" }];
    const read = candidate([["Shilajit (Asphaltum) Exd.", "333.33mg"]]);
    const positions = proseAmounts(
      read,
      { text: "", lines: twice },
      { confirmed: [], misplaced: [] },
    );
    expect(positions.confirmed).toEqual([]);
  });
});
