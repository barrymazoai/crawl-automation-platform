import { describe, expect, it } from "vitest";
import { decodeTranscriptAnswer } from "./protocol/label-transcript-answer.js";
import { decodeVisionResult } from "./protocol/vision-protocol.js";
import { transcribedAnswer, type TranscriptCalls } from "./vision-transcript-flow.js";

/**
 * Owner 2026-11-06 (Be Bodywise Biotin gummies, amazon.in B092ZXX7XP): the jar prints its facts panel on one side and
 * its ingredients on another image. The copy of the panel was right; the label protocol it fell back to read
 * "1000 mcg" for the printed "10000 mcg".
 */
const policy = { allowNoOtherIngredientsSection: true };
const task = { extractionProtocol: "label-extraction/1", operationId: "op-1" } as never;
const row = (...cells: string[]) => ({ cells, indent: 0, bold: false });

function panelOnly(state = "not_fully_visible", otherIngredients: string | null = null) {
  return {
    codec: "label-visual-wire/4",
    panels: [
      {
        heading: "Supplement Facts",
        servingLines: ["Serving Size 1 Gummy"],
        columnHeaders: ["Amount Per Serving", "% Daily Value"],
        rows: [
          row("Biotin", "30 mcg", "100%"),
          row("Sesbania grandiflora extract", "10000 mcg", "*"),
        ],
        footnotes: [],
      },
    ],
    otherIngredientsHeading: null,
    otherIngredients,
    otherIngredientsState: state,
    wholeLabelVisible: false,
    issues: [],
  };
}

function calls(transcript: unknown, reread?: unknown) {
  const made: string[] = [];
  const reasons: string[] = [];
  const fake: TranscriptCalls = {
    transcribe: async () => (made.push("transcribe"), JSON.stringify(transcript)),
    reread: async (names) => (made.push(`reread:${names.join("|")}`), JSON.stringify(reread)),
    label: async (attempt) => (made.push("label"), reasons.push(attempt.reason), "label answer"),
  };
  return { fake, made, reasons };
}

function ocr(rows: [string, string][]) {
  const at = (left: number, top: number): [number, number][] => [
    [left, top],
    [left + 200, top],
    [left + 200, top + 12],
    [left, top + 12],
  ];
  const lines = rows.flatMap(([name, amount], index) => [
    { text: name, polygon: at(0, index * 20) },
    ...(amount ? [{ text: amount, polygon: at(300, index * 20) }] : []),
  ]);
  return { text: lines.map((line) => line.text).join("\n"), lines };
}

const amounts = (answer: string) =>
  (decodeTranscriptAnswer(answer).candidate.formula?.columns[0]?.rows ?? []).map(
    (read) => read.amount?.text,
  );

describe("a copied panel whose ingredients are printed on another image", () => {
  it("keeps the copy when the OCR confirms every amount; only the ingredients stay open", async () => {
    const { fake, made } = calls(panelOnly());

    const answer = await transcribedAnswer({
      calls: fake,
      ocr: ocr([
        ["Biotin", "30 mcg"],
        ["Sesbania grandiflora extract", "10000 mcg"],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe"]);
    expect(decodeVisionResult(task, answer)).toMatchObject({
      status: "review",
      codes: ["LABEL.INGREDIENTS_INCOMPLETE"],
    });
    expect(amounts(answer)).toEqual(["30 mcg", "10000 mcg"]);
  });

  it("re-reads the amounts the OCR does not show and keeps the copy when the re-read agrees", async () => {
    const reread = { rows: [{ name: "Sesbania grandiflora extract", amountCells: ["10000 mcg"] }] };
    const { fake, made } = calls(panelOnly(), reread);

    const answer = await transcribedAnswer({
      calls: fake,
      ocr: ocr([
        ["Biotin", "30 mcg"],
        ["Sesbania grandiflora extract", ""],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe", "reread:Sesbania grandiflora extract"]);
    expect(amounts(answer)).toEqual(["30 mcg", "10000 mcg"]);
  });

  it("reads the image with the label protocol when the re-read gives another amount", async () => {
    const reread = { rows: [{ name: "Sesbania grandiflora extract", amountCells: ["1000 mcg"] }] };
    const { fake, made, reasons } = calls(panelOnly(), reread);

    await transcribedAnswer({
      calls: fake,
      ocr: ocr([
        ["Biotin", "30 mcg"],
        ["Sesbania grandiflora extract", ""],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe", "reread:Sesbania grandiflora extract", "label"]);
    expect(reasons[0]).toMatch(/^re-read not accepted: /);
  });

  it("still reads the image with the label protocol when the copy calls the ingredients unreadable", async () => {
    const { fake, made, reasons } = calls(panelOnly("unreadable"));

    await transcribedAnswer({
      calls: fake,
      ocr: ocr([
        ["Biotin", "30 mcg"],
        ["Sesbania grandiflora extract", "10000 mcg"],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe", "label"]);
    expect(reasons).toEqual(["checks: LABEL.INGREDIENTS_INCOMPLETE"]);
  });
});

describe("a copied row that prints two ingredients side by side", () => {
  it("is not read by the row rules, which would keep only the first ingredient", async () => {
    const paired = {
      ...panelOnly("present", "Whey protein."),
      otherIngredientsHeading: "Ingredients:",
      panels: [
        {
          heading: "Nutrition Facts",
          servingLines: ["Serving size: 1 Tablespoon (5g)"],
          columnHeaders: ["Amount Per Serving", "% Daily Value"],
          rows: [
            row("Protein", "3g", ""),
            row("Iron", "2%", "Thiamine (B1)", "180%"),
            row("Riboflavin (B2)", "160%", "Niacin (B3)", "70%"),
          ],
          footnotes: [],
        },
      ],
    };
    const { fake, made, reasons } = calls(paired);

    await transcribedAnswer({ calls: fake, ocr: ocr([["Protein", "3g"]]), policy });

    expect(made).toEqual(["transcribe", "label"]);
    expect(reasons).toEqual(["copy not parsed: two ingredients in one row"]);
  });

  it("keeps a row whose last cell is a footnote, not a second ingredient", async () => {
    const footnote = {
      ...panelOnly(),
      panels: [
        {
          ...panelOnly().panels[0],
          rows: [row("Turmeric root", "500 mg", "Daily Value not established")],
        },
      ],
    };
    const { fake, made } = calls(footnote);

    await transcribedAnswer({ calls: fake, ocr: ocr([["Turmeric root", "500 mg"]]), policy });

    expect(made).toEqual(["transcribe"]);
  });
});
