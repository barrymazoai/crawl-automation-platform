import { describe, expect, it } from "vitest";
import { splitLabelIngredients } from "@crawl-automation/v3-contracts";
import { rereadConfirmedRows } from "./label-transcript-answer.js";
import { transcriptCandidate } from "./label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./label-transcript-wire.js";

/**
 * Owner 2026-11-08 (KAN-243, 12 amazon.in labels copied by Luna high with the revised copy prompt): lines beside the
 * table are filed under "servingLines"; only the ones the format reads as the serving are kept, none becomes a row.
 */
const INDIA = ["us-facts/1", "in-nutritional-information/2", "in-composition/2"] as const;
const policy = { allowNoOtherIngredientsSection: true };
const row = (...cells: string[]) => ({ cells, indent: 0, bold: false });
const wire = (panel: unknown, otherIngredients: string | null = null) =>
  labelTranscriptWireSchema.parse({
    codec: "label-visual-wire/4",
    panels: [panel],
    otherIngredientsHeading: otherIngredients ? "INGREDIENTS" : null,
    otherIngredients,
    otherIngredientsState: otherIngredients ? "present" : "not_fully_visible",
    wholeLabelVisible: !!otherIngredients,
    issues: [],
  });
const read = (built: ReturnType<typeof transcriptCandidate>) => {
  if ("reason" in built) {
    throw new Error(built.reason);
  }
  const formula = built.candidate.formula;
  return {
    serving: formula?.servingSize?.text ?? null,
    servings: formula?.servingsPerContainer?.text ?? null,
    rows: formula?.columns[0]?.rows.map((each) => [each.name.text, each.amount?.text ?? null]),
  };
};

describe("lines filed beside the table", () => {
  it("India: the serving is read; a usage line is no row (The Whole Truth plant protein)", () => {
    const panel = {
      heading: "NUTRITIONAL INFORMATION",
      servingLines: [
        "1 levelled scoop serving - 38g • No. of servings: 26 (approx)",
        "Recommended usage level: 1-2 servings per day",
      ],
      columnHeaders: ["", "per 100 g", "per 38 g serving", "%RDA/ serve"],
      rows: [
        row("energy (kcal#)", "396.0", "150.5", "7.5% •"),
        row("protein (g)", "66.9", "25.4", "47.1% ○"),
      ],
      footnotes: [],
    };
    expect(read(transcriptCandidate(wire(panel), policy, INDIA))).toEqual({
      serving: "1 levelled scoop serving - 38g",
      servings: "26 (approx)",
      rows: [
        ["energy (kcal#)", "150.5"],
        ["protein (g)", "25.4"],
      ],
    });
  });

  it("US: Serving Size and Servings Per Container are read; '8 SHOTS' is no row", () => {
    const panel = {
      heading: "Supplement Facts",
      servingLines: ["Serving Size: 5 ml", "Servings Per Container: 8", "8 SHOTS"],
      columnHeaders: ["", "Amount Per Serving"],
      rows: [row("Vitamin D3 (as cholecalciferol)", "1500 mcg")],
      footnotes: [],
    };
    expect(read(transcriptCandidate(wire(panel), policy))).toEqual({
      serving: "5 ml",
      servings: "8",
      rows: [["Vitamin D3 (as cholecalciferol)", "1500 mcg"]],
    });
  });
});

describe("an ingredient list printed one item per line", () => {
  it("is split at its line breaks, a comma before a break adding no item", () => {
    expect(
      splitLabelIngredients("pea protein isolate 51.8%\nbrown rice protein isolate 22.2%"),
    ).toEqual(["pea protein isolate 51.8%", "brown rice protein isolate 22.2%"]);
    expect(splitLabelIngredients("Whey, Cocoa,\nSalt")).toEqual(["Whey", "Cocoa", "Salt"]);
    expect(
      splitLabelIngredients(
        "whey protein blend 74.9%\n(instantised with lecithin)\nwhey protein isolate 50.0%",
      ),
    ).toEqual([
      "whey protein blend 74.9% (instantised with lecithin)",
      "whey protein isolate 50.0%",
    ]);
  });

  it("India: the closing '100%' on its own line is no ingredient", () => {
    const panel = {
      heading: "NUTRITIONAL INFORMATION",
      servingLines: [],
      columnHeaders: ["", "per 38 g serving"],
      rows: [row("protein (g)", "25.4")],
      footnotes: [],
    };
    const built = transcriptCandidate(
      wire(panel, "pea protein isolate 51.8%\ncocoa powder 20.5%\n100%"),
      policy,
      INDIA,
    );
    expect("block" in built ? built.block?.text : built.reason).toBe(
      "pea protein isolate 51.8%\ncocoa powder 20.5%",
    );
  });
});

describe("a re-read of an Indian row with two amount columns", () => {
  const copied = labelTranscriptWireSchema.parse({
    codec: "label-visual-wire/4",
    panels: [
      {
        heading: "NUTRITIONAL INFORMATION",
        servingLines: [],
        columnHeaders: ["", "per 100 g", "per 38 g serving", "%RDA/serve"],
        rows: [
          row("protein (g)", "66.9", "25.4", "47.1% •"),
          row("cholesterol (mg)", "<1.0", "0.0", "–"),
        ],
        footnotes: [],
      },
    ],
    otherIngredientsHeading: null,
    otherIngredients: null,
    otherIngredientsState: "not_fully_visible",
    wholeLabelVisible: false,
    issues: [],
  });
  const built = transcriptCandidate(copied, policy, INDIA);
  if ("reason" in built) {
    throw new Error(built.reason);
  }
  const reread = (cells: string[]) =>
    JSON.stringify({ rows: [{ name: "cholesterol (mg)", amountCells: cells }] });

  it("confirms the per-serving amount when both cells match the copy, units from the row name", () => {
    expect(rereadConfirmedRows(built.candidate, reread(["<1.0 mg", "0.0 mg"]), copied)).toEqual([
      1,
    ]);
  });

  it("does not confirm a re-read that prints another number in either column", () => {
    expect(rereadConfirmedRows(built.candidate, reread(["<1.0 mg", "0.6 mg"]), copied)).toEqual([]);
    expect(rereadConfirmedRows(built.candidate, reread(["1.0 mg", "0.0 mg"]), copied)).toEqual([]);
  });
});
