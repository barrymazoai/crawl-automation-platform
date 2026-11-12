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

describe("the serving and the pack's count copied on one line (amazon.in rerun 2026-11-08)", () => {
  const panel = (servingLine: string) => ({
    heading: "NUTRITIONAL INFORMATION",
    servingLines: [servingLine],
    columnHeaders: ["Nutrients", "Per Serving", "%RDA"],
    rows: [row("Protein (g)", "24", "44%")],
    footnotes: [],
  });
  it.each([
    ["Serving Size: 1 Scoop (36g) | Servings Per Container: ~28", "1 Scoop (36g)", "~28"],
    ["Serving size: 2 softgels (2.6g) | Number of Servings per pack 30", "2 softgels (2.6g)", "30"],
    ["Serving Size: 1 Level Scoop (4g), Servings Per Container: 30", "1 Level Scoop (4g)", "30"],
    ["Servings per container: 30    Serving size: 1 Tablet", "1 Tablet", "30"],
    ["SERVING SIZE: 40.50G, NO. OF SERVINGS - 1", "40.50G", "1"],
    [
      "Servings per container: 33 Servings | Serving Size: 1 Heaped Scoop (~3.7g)",
      "1 Heaped Scoop (~3.7g)",
      "33 Servings",
    ],
    [
      "1 levelled scoop serving = 35 g • No. of servings: 28 (approx.)",
      "1 levelled scoop serving = 35 g",
      "28 (approx.)",
    ],
    [
      "Serv Size - 2.38 g (1 sachet) Servings per pack - 30 sachets",
      "2.38 g (1 sachet)",
      "30 sachets",
    ],
  ])("%s", (line, serving, servings) => {
    const built = read(transcriptCandidate(wire(panel(line)), policy, INDIA));
    expect([built.serving, built.servings]).toEqual([serving, servings]);
  });

  it("reads a line with a long run of spaces at once (amazon.de label model worker held for good, 2026-11-12)", () => {
    const started = performance.now();
    const built = read(
      transcriptCandidate(
        wire(panel(`Serving Size: 1 Tablet${" ".repeat(3900)}Servings Per Container: 60`)),
        policy,
        INDIA,
      ),
    );
    expect([built.serving, built.servings]).toEqual(["1 Tablet", "60"]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("nutrients of a running line under a headed table (HealthyHey Magnesium Glycinate, 2026-11-08)", () => {
  const panel = (extra: ReturnType<typeof row>[], headers: string[]) => ({
    heading: "NUTRITIONAL INFORMATION",
    servingLines: ["Serving Size: 1 Veg. Capsule (0.73 g)", "Servings Per Container: 120"],
    columnHeaders: headers,
    rows: [
      row("Magnesium Glycinate", "550 mg", "**", "**"),
      row("Elemental Magnesium 22%", "121 mg", "27.50", "32.70"),
      ...extra,
    ],
    footnotes: [],
  });
  const ONE_AMOUNT = ["Nutrients", "Amount Per Serving", "*% RDA Men", "*% RDA Women"];

  it("takes each nutrient's amount from the one amount column", () => {
    const built = transcriptCandidate(
      wire(panel([row("Energy Value", "0 kcal"), row("Protein", "0 g")], ONE_AMOUNT)),
      policy,
      INDIA,
    );
    expect(read(built).rows).toEqual([
      ["Magnesium Glycinate", "550 mg"],
      ["Elemental Magnesium 22%", "121 mg"],
      ["Energy Value", "0 kcal"],
      ["Protein", "0 g"],
    ]);
  });

  it("leaves a lone percentage, or a lone cell under per 100 g and per serving columns, unaligned", () => {
    const percent = transcriptCandidate(
      wire(panel([row("Energy Value", "0%")], ONE_AMOUNT)),
      policy,
      INDIA,
    );
    expect("reason" in percent && percent.reason).toMatch(/not aligned/);
    const twoAmounts = transcriptCandidate(
      wire(
        panel([row("Energy Value", "0 kcal")], ["Nutrients", "Per 100 g", "Per Serving", "%RDA"]),
      ),
      policy,
      INDIA,
    );
    expect("reason" in twoAmounts && twoAmounts.reason).toMatch(/not aligned/);
  });
});
