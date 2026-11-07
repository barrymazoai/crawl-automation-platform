import { describe, expect, it } from "vitest";
import { transcriptCandidate } from "./label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./label-transcript-wire.js";

/** Owner 2026-11-07: India market rules for copied panels, on panels copied from the 2026-11-06 amazon.in batch. */
const INDIA = ["us-facts/1", "in-nutritional-information/2", "in-composition/2"] as const;
const policy = { allowNoOtherIngredientsSection: true };
const row = (...cells: string[]) => ({ cells, indent: 0, bold: false });
const panel = (heading: string | null, columnHeaders: string[], rows: string[][]) => ({
  heading,
  servingLines: [],
  columnHeaders,
  rows: rows.map((cells) => row(...cells)),
  footnotes: [],
});
const wire = (panels: unknown[]) =>
  labelTranscriptWireSchema.parse({
    codec: "label-visual-wire/4",
    panels,
    otherIngredientsHeading: null,
    otherIngredients: null,
    otherIngredientsState: "not_fully_visible",
    wholeLabelVisible: false,
    issues: [],
  });
const read = (built: ReturnType<typeof transcriptCandidate>) =>
  "reason" in built
    ? built.reason
    : built.candidate.formula?.columns[0]?.rows.map((each) => [
        each.name.text,
        each.amount?.text ?? null,
      ]);

// MuscleBlaze CreAMP creatine: a composition table and the nutritional information beside it.
const composition = panel(
  "COMPOSITION",
  ["AMOUNT PER SERVING", ""],
  [
    ["Creatine Monohydrate", "3.0 g"],
    ["MB CreAbsorb™", "0.1 g"],
  ],
);
const nutrition = panel(
  "NUTRITIONAL INFORMATION (APPROX VALUES):",
  ["", "Qty./100g", "Qty./Serving", "%RDA^"],
  [
    ["Energy (kcal)", "2.9", "0.09", ""],
    ["Protein (g)", "0", "0", "0.00%"],
  ],
);

describe("India: two panels of one label", () => {
  it("are read as one formula, each row under its own panel's columns", () => {
    expect(read(transcriptCandidate(wire([composition, nutrition]), policy, INDIA))).toEqual([
      ["Creatine Monohydrate", "3.0 g"],
      ["MB CreAbsorb™", "0.1 g"],
      ["Energy (kcal)", "0.09"],
      ["Protein (g)", "0"],
    ]);
  });

  it("are not joined when the second repeats the first (one table copied twice)", () => {
    expect(read(transcriptCandidate(wire([nutrition, nutrition]), policy, INDIA))).toBe(
      "panels: 2",
    );
  });

  it("are not joined for the US market", () => {
    expect(read(transcriptCandidate(wire([composition, nutrition]), policy))).toBe("panels: 2");
  });

  it("an amino acid profile named only in its first column header is set aside (Naturaltein)", () => {
    const amino = panel(
      null,
      ["Amino Acid Profile", "Per 100g", "Amino Acid Profile", "Per 100g"],
      [["Alanine", "3.2 g", "Lysine", "4.7 g"]],
    );
    expect(read(transcriptCandidate(wire([nutrition, amino]), policy, INDIA))).toEqual([
      ["Energy (kcal)", "0.09"],
      ["Protein (g)", "0"],
    ]);
  });
});

describe("India: the amount column and notes copied as rows", () => {
  it("reads 'Approx Value Per Serving', 'QUANTITY' and the serving's own weight as the amount column", () => {
    const naturaltein = panel(
      "NUTRITION INFORMATION",
      ["Nutrients", "Approx Value Per Serving", "RDA%*"],
      [["Elemental Magnesium", "150 mg", "34.09*"]],
    );
    const wellbeing = panel(
      "SUPPLEMENT FACTS",
      ["INGREDIENTS", "QUANTITY", "*%RDA"],
      [["Elemental Magnesium", "220 mg", "50%"]],
    );
    const nutrabay = panel(
      "NUTRITION FACTS",
      ["Nutrients", "3.1 g", "100 g", "% RDA"],
      [["Creatine Monohydrate", "3 g", "96.8 g", "--"]],
    );
    for (const [copied, amount] of [
      [naturaltein, "150 mg"],
      [wellbeing, "220 mg"],
      [nutrabay, "3 g"],
    ] as const) {
      expect(read(transcriptCandidate(wire([copied]), policy, INDIA))).toEqual([
        [copied.rows[0]?.cells[0], amount],
      ]);
    }
  });

  it("'Per Serve % RDA' is the percentage column, never a per-serving amount (Organic India)", () => {
    const isabgol = panel(
      "NUTRITIONAL INFORMATION",
      ["", "Per 100g", "Per Serve % RDA"],
      [["Energy (kcal)", "375", "0.9"]],
    );
    expect(read(transcriptCandidate(wire([isabgol]), policy, INDIA))).toEqual([
      ["Energy (kcal)", "375"],
    ]);
  });

  it("leaves out notes copied as rows: '(Approximate values)', '90 TABLETS', 'EACH SERVING OF … PROVIDES'", () => {
    const copied = panel(
      "NUTRITIONAL INFORMATION",
      ["", "Per serving", "%RDA"],
      [
        ["(Approximate values)", "", ""],
        ["90 TABLETS", "", ""],
        ["EACH SERVING OF OMEFISH ULTRA PROVIDES", "", ""],
        ["Vitamin E", "10 mg", "100%"],
      ],
    );
    expect(read(transcriptCandidate(wire([copied]), policy, INDIA))).toEqual([
      ["Vitamin E", "10 mg"],
    ]);
  });
});
