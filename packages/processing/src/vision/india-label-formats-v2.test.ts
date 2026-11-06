import { describe, expect, it, vi } from "vitest";
import type { LabelFormatId } from "@crawl-automation/v3-contracts";
import { INDIA, policy, row, rowsOf, wire } from "./india-label-fixture.js";
import { transcriptCandidate } from "./protocol/label-transcript-candidate.js";
import { UNREADABLE_CELL } from "./protocol/label-transcript-wire.js";
import { explicitNoneWire, printed } from "./protocol/ingredient-presence-fixture.js";
import {
  decodeIngredientPresenceAnswer,
  retainIngredientPresenceAnswer,
} from "./protocol/label-ingredient-presence.js";
import { transcribedAnswer } from "./vision-transcript-flow.js";

// Cells copied from the stored transcripts of the first 20 real amazon.in labels (2026-11-06, plan §10.7).
describe("Indian label formats /2: the first 20 real amazon.in labels", () => {
  const V1: LabelFormatId[] = ["us-facts/1", "in-nutritional-information/1", "in-composition/1"];

  it("reads a %RDA header with a footnote mark in front, and joins a description line to its ingredient", () => {
    const tata = wire({
      columnHeaders: ["Nutrients", "Qty./Serving", "*%RDA"],
      servingLines: ["Serving size: 2 tablets (2.44 g)"],
      rows: [
        row("Energy*", "6.00 kcal", "0.30"),
        row("Magnesium", "440 mg", "100"),
        row("(Magnesium bisglycinate buffered with Magnesium hydroxide)"),
      ],
    });
    const read = rowsOf(transcriptCandidate(tata, policy, INDIA));
    expect(read).toMatchObject({ heading: "Qty./Serving", dailyValueHeading: "*%RDA" });
    expect(read.rows).toEqual([
      ["Energy*", "6.00 kcal", "0.30"],
      ["Magnesium (Magnesium bisglycinate buffered with Magnesium hydroxide)", "440 mg", "100"],
    ]);
    // /1 did not know the mark: its candidate had no percentage header (it fell back in production).
    expect(transcriptCandidate(tata, policy, V1)).not.toMatchObject({
      candidate: { formula: { columns: [{ dailyValueHeading: expect.anything() }] } },
    });
  });

  it("reads the first of two marked RDA columns and an 'Each Serving Provides' amount column", () => {
    const healthyHey = wire({
      columnHeaders: ["Nutrients", "Amount Per Serving", "*% RDA Men", "*% RDA Women"],
      rows: [
        row("Magnesium Glycinate", "550 mg", "**", "**"),
        row("Elemental Magnesium 22%", "121 mg", "27.50", "32.70"),
      ],
    });
    expect(rowsOf(transcriptCandidate(healthyHey, policy, INDIA))).toMatchObject({
      dailyValueHeading: "*% RDA Men",
      rows: [
        ["Magnesium Glycinate", "550 mg", "**"],
        ["Elemental Magnesium 22%", "121 mg", "27.50"],
      ],
    });
    const carbamide = wire({
      columnHeaders: ["Nutritional Information (Approx. Values)", "Each Serving Provides", "%RDA"],
      rows: [row("Energy Value", "0.5 kcal", "0.02%"), row("Magnesium Glycinate", "2000 mg", "†")],
    });
    expect(rowsOf(transcriptCandidate(carbamide, policy, INDIA))).toMatchObject({
      heading: "Each Serving Provides",
      dailyValueHeading: "%RDA",
      rows: [
        ["Energy Value", "0.5 kcal", "0.02%"],
        ["Magnesium Glycinate", "2000 mg", "†"],
      ],
    });
  });

  it("reads serving lines printed inside the table and drops section headings", () => {
    const centrum = wire({
      columnHeaders: ["", "QTY./SERVING", "%RDA"],
      rows: [
        row("1 SERVING (1=1 TABLET)"),
        row("VITAMINS"),
        row("VITAMIN A", "800 mcg", "(80%,95%)"),
        row("MINERALS"),
      ],
    });
    expect(rowsOf(transcriptCandidate(centrum, policy, INDIA))).toMatchObject({
      servingSize: "1 SERVING (1=1 TABLET)",
      rows: [["VITAMIN A", "800 mcg", "(80%,95%)"]],
    });
    const goodMonk = wire({
      columnHeaders: ["", "Per sachet\n2.38 g", "% RDA for\n1 sachet**", "% RDA for\n2 sachets**"],
      rows: [
        row("Serv Size - 2.38 g (1 sachet)  Servings per pack - 30"),
        row("Energy (kcal)", "4", "0.2", "0.4"),
      ],
    });
    expect(rowsOf(transcriptCandidate(goodMonk, policy, INDIA))).toMatchObject({
      servingSize: "2.38 g (1 sachet)",
      servingsPerContainer: "30",
      rows: [["Energy (kcal)", "4", "0.2"]],
    });
    const diaFree = wire({
      columnHeaders: ["Contents", "Per 30ml", "Per 100ml", "**%RDA Per Serve"],
      rows: [row("Serve Size: 30ml"), row("Energy (kcal)", "8.89", "29.63", "0.44")],
    });
    expect(rowsOf(transcriptCandidate(diaFree, policy, INDIA))).toMatchObject({
      heading: "Per 30ml",
      dailyValueHeading: "**%RDA Per Serve",
      servingSize: "30ml",
      rows: [["Energy (kcal)", "8.89", "0.44"]],
    });
  });

  it("reads two tables printed side by side as one table after the other", () => {
    const half = ["Nutrients", "Qty/Serving(8g)", "Qty./100g", "%RDA*"];
    const hkVitals = wire({
      columnHeaders: [...half, ...half],
      rows: [
        row("Energy (kcal)", "27.81", "347.6", "1.39", "Vitamin C ^ (mg)", "40", "500", "61.54"),
        row(
          "Ingredients",
          "Qty/Serving(8g)",
          "Qty./100g",
          "%RDA*",
          "Vitamins",
          "Qty/Serving(8g)",
          "Qty./100g",
          "%RDA*",
        ),
        row(
          "Marine Collagen Peptides (g)",
          "5",
          "62.5",
          "—",
          "Biotin ^ (mcg)",
          "30",
          "375",
          "75.00",
        ),
      ],
    });
    expect(rowsOf(transcriptCandidate(hkVitals, policy, INDIA)).rows).toEqual([
      ["Energy (kcal)", "27.81", "1.39"],
      ["Marine Collagen Peptides (g)", "5", "—"],
      ["Vitamin C ^ (mg)", "40", "61.54"],
      ["Biotin ^ (mcg)", "30", "75.00"],
    ]);
  });

  it("leaves the Composition filler 'Excipients q.s.' out of the formula", () => {
    const shilajit = wire({
      heading: "Composition",
      servingLines: ["Each 1g contains:"],
      rows: [row("Shilajit (Asphaltum) Exd.", "333.33mg"), row("Excipients", "q.s.")],
    });
    expect(rowsOf(transcriptCandidate(shilajit, policy, INDIA))).toMatchObject({
      servingSize: "1g",
      rows: [["Shilajit (Asphaltum) Exd.", "333.33mg", null]],
    });
  });
});

describe("the copied %RDA header on an answer read with the label protocol (KAN-243)", () => {
  // Tata 1mg Magnesium (2026-11-06): the copy was not accepted, the label protocol read the table, and its answer had
  // no percentage header, so Supply Smart read the %RDA numbers as US %DV.
  const copy = (rows: ReturnType<typeof row>[]) =>
    JSON.stringify(wire({ columnHeaders: ["Nutrients", "Qty./Serving", "*%RDA"], rows }));
  const unreadable = copy([
    row("Energy*", "6.00 kcal", "0.30"),
    row("Magnesium", UNREADABLE_CELL, "100"),
  ]);

  async function fellBack(formats: readonly LabelFormatId[] | undefined) {
    const label = vi.fn(async (_attempt: unknown, _heading?: string | null) => "label answer");
    await transcribedAnswer({
      calls: { transcribe: async () => unreadable, reread: async () => "{}", label },
      ocr: { text: "", lines: [] },
      policy,
      formats,
    });
    return label.mock.calls[0];
  }

  it("names the copy's percentage header when the label protocol reads an Indian table instead", async () => {
    expect(await fellBack(INDIA)).toEqual([
      expect.objectContaining({ reason: expect.any(String) }),
      "*%RDA",
    ]);
    expect((await fellBack(["us-facts/1"]))?.[1]).toBeNull();
    expect((await fellBack(undefined))?.[1]).toBeNull();
  });

  it("puts that header on the one column whose rows print percentages, and nothing without one", () => {
    const answer = explicitNoneWire();
    const component = answer.label.formula?.columns[0]?.rows[1];
    if (!component) {
      throw new Error("fixture has no component row");
    }
    component.dailyValue = printed("100");
    const read = (dailyValueHeading?: string) =>
      decodeIngredientPresenceAnswer(
        retainIngredientPresenceAnswer(JSON.stringify(answer), policy, { dailyValueHeading }),
      ).candidate.formula?.columns[0]?.dailyValueHeading ?? null;
    expect(read("*%RDA")).toEqual({ text: "*%RDA", evidence: "*%RDA" });
    expect(read()).toBeNull();
    const us = retainIngredientPresenceAnswer(JSON.stringify(answer), policy);
    expect(JSON.parse(us)).not.toHaveProperty("dailyValueHeading");
  });
});
