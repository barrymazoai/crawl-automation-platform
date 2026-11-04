import { describe, expect, it } from "vitest";
import { decodeVisionResult } from "./protocol/vision-protocol.js";
import { decodeTranscriptAnswer } from "./protocol/label-transcript-answer.js";
import { CodexVisionModel } from "./codex-vision-model.js";
import { transcribedAnswer, type TranscriptCalls } from "./vision-transcript-flow.js";

const policy = { allowNoOtherIngredientsSection: true };
const row = (...cells: string[]) => ({ cells, indent: 0, bold: false });

function wire(
  rows = [row("Vitamin C (as ascorbic acid)", "90 mg", "100%"), row("Zinc", "11 mg", "100%")],
) {
  return {
    codec: "label-visual-wire/4",
    panels: [
      {
        heading: "Supplement Facts",
        servingLines: ["Serving Size 1 Capsule"],
        columnHeaders: ["Amount Per Serving", "% Daily Value"],
        rows,
        footnotes: [],
      },
    ],
    otherIngredientsHeading: "Other Ingredients:",
    otherIngredients: "Cellulose, Magnesium Stearate.",
    otherIngredientsState: "present",
    wholeLabelVisible: false,
    issues: [],
  };
}

function calls(transcript: unknown, reread?: unknown) {
  const made: string[] = [];
  const fake: TranscriptCalls = {
    transcribe: async () => (made.push("transcribe"), JSON.stringify(transcript)),
    reread: async (names) => (made.push(`reread:${names.join("|")}`), JSON.stringify(reread)),
    label: async () => (made.push("label"), "label-visual-answer/3 envelope"),
  };
  return { fake, made };
}

const task = { extractionProtocol: "label-extraction/1", operationId: "op-1" } as never;

/** An OCR reading of a printed panel: each name at the left of its row, each amount further right on the same row. */
function printed(rows: [name: string, amount: string][]) {
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

describe("transcribed image reading (owner 2026-11-04)", () => {
  it("keeps the code-parsed copy when the OCR prints every amount on its own row", async () => {
    const { fake, made } = calls(wire());

    const answer = await transcribedAnswer({
      calls: fake,
      ocr: printed([
        ["Vitamin C (as ascorbic acid)", "90 mg 100%"],
        ["Zinc", "11mg 100%"],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe"]);
    expect(decodeVisionResult(task, answer).status).toBe("candidate");
    const decoded = decodeTranscriptAnswer(answer);
    expect(decoded.status).toBe("candidate");
    const rows = decoded.candidate.formula?.columns[0]?.rows ?? [];
    expect(rows.map((read) => [read.name.text, read.amount?.text])).toEqual([
      ["Vitamin C (as ascorbic acid)", "90 mg"],
      ["Zinc", "11 mg"],
    ]);
    expect(decoded.candidate.otherIngredients?.items.map((item) => item.text)).toEqual([
      "Cellulose",
      "Magnesium Stearate.",
    ]);
  });

  it("takes a dose printed after the name when the row has no amount cell (Nutrition Facts)", async () => {
    const { fake, made } = calls(wire([row("Sodium 55mg", "2%"), row("Herb Blend 650 mg", "**")]));

    const answer = await transcribedAnswer({
      calls: fake,
      ocr: printed([
        ["Sodium 55mg 2%", ""],
        ["Herb Blend 650 mg **", ""],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe"]);
    const rows = decodeTranscriptAnswer(answer).candidate.formula?.columns[0]?.rows ?? [];
    expect(rows.map((read) => [read.name.text, read.amount?.text])).toEqual([
      ["Sodium", "55mg"],
      ["Herb Blend", "650 mg"],
    ]);
  });

  it("re-reads only the rows the OCR does not show, and keeps the copy when the re-read agrees", async () => {
    const reread = { rows: [{ name: "Zinc", amountCells: ["11 mg"] }] };
    const { fake, made } = calls(wire(), reread);

    const answer = await transcribedAnswer({
      calls: fake,
      ocr: printed([
        ["Vitamin C (as ascorbic acid)", "90 mg"],
        ["Zinc", ""],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe", "reread:Zinc"]);
    expect(decodeVisionResult(task, answer).status).toBe("candidate");
  });

  it("never takes '11 mg' from a longer printed number such as '111 mg'", async () => {
    const reread = { rows: [{ name: "Zinc", amountCells: ["11 mg"] }] };
    const { fake, made } = calls(wire(), reread);

    await transcribedAnswer({
      calls: fake,
      ocr: printed([
        ["Vitamin C (as ascorbic acid)", "90 mg"],
        ["Zinc", "111 mg"],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe", "reread:Zinc"]);
  });

  it("reads the image with the label protocol when the re-read gives another amount", async () => {
    const reread = { rows: [{ name: "Zinc", amountCells: ["1.1 mg"] }] };
    const { fake, made } = calls(wire(), reread);

    const answer = await transcribedAnswer({
      calls: fake,
      ocr: printed([
        ["Vitamin C (as ascorbic acid)", "90 mg"],
        ["Zinc", ""],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe", "reread:Zinc", "label"]);
    expect(answer).toBe("label-visual-answer/3 envelope");
  });

  it("reads the image with the label protocol when the copy cannot be parsed faithfully", async () => {
    const twoColumns = wire([row("Vitamin C", "90 mg", "180 mg", "100%")]);
    const unreadable = wire([row("Vitamin C", "9[UNREADABLE] mg", "100%")]);
    const twoPanels = { ...wire(), panels: [...wire().panels, ...wire().panels] };

    for (const transcript of [twoColumns, unreadable, twoPanels, { not: "a transcript" }]) {
      const { fake, made } = calls(transcript);
      await transcribedAnswer({ calls: fake, ocr: printed([["Vitamin C", "90 mg"]]), policy });
      expect(made).toEqual(["transcribe", "label"]);
    }
  });

  it("reads the image with the label protocol, never a re-read, when the OCR prints a copied amount on another row", async () => {
    // The copy gives Vitamin C 90 mg and Zinc 11 mg; the label prints 11 mg on the Vitamin C row and 90 mg on Zinc's.
    const reread = { rows: [{ name: "Zinc", amountCells: ["11 mg"] }] };
    const { fake, made } = calls(wire(), reread);

    const answer = await transcribedAnswer({
      calls: fake,
      ocr: printed([
        ["Vitamin C (as ascorbic acid)", "11 mg"],
        ["Zinc", "90 mg"],
      ]),
      policy,
    });

    expect(made).toEqual(["transcribe", "label"]);
    expect(answer).toBe("label-visual-answer/3 envelope");
  });

  it("reads a printed line the OCR split into pieces ('0.65' | 'mg', 'Vitamin' | 'C')", async () => {
    const { fake, made } = calls(wire());
    const box = (left: number, top: number, width: number): [number, number][] => [
      [left, top],
      [left + width, top],
      [left + width, top + 12],
      [left, top + 12],
    ];
    const lines = [
      { text: "Vitamin", polygon: box(0, 0, 60) },
      { text: "C (as ascorbic acid)", polygon: box(64, 1, 140) },
      { text: "90", polygon: box(300, 0, 20) },
      { text: "mg", polygon: box(324, 1, 20) },
      { text: "Zinc", polygon: box(0, 20, 40) },
      { text: "11", polygon: box(300, 21, 20) },
      { text: "mg", polygon: box(324, 20, 20) },
    ];

    await transcribedAnswer({ calls: fake, ocr: { text: "", lines }, policy });

    expect(made).toEqual(["transcribe"]);
  });

  it("an OCR result without line positions confirms no amount: every amount is re-read", async () => {
    const reread = {
      rows: [
        { name: "Vitamin C (as ascorbic acid)", amountCells: ["90 mg"] },
        { name: "Zinc", amountCells: ["11 mg"] },
      ],
    };
    const { fake, made } = calls(wire(), reread);

    const answer = await transcribedAnswer({
      calls: fake,
      ocr: { text: "Vitamin C 90 mg Zinc 11 mg", lines: [] },
      policy,
    });

    expect(made).toEqual(["transcribe", "reread:Vitamin C (as ascorbic acid)|Zinc"]);
    expect(decodeVisionResult(task, answer).status).toBe("candidate");
  });

  it("a saved copy whose amount nothing confirmed decodes to a Review, never a guess", () => {
    const answer = JSON.stringify({
      codec: "label-visual-answer/4",
      policy,
      raw: JSON.stringify(wire()),
      ocrConfirmed: [0],
      reread: null,
    });

    expect(decodeVisionResult(task, answer)).toMatchObject({
      status: "review",
      code: "VISION.LABEL_AMOUNT_UNREADABLE",
    });
  });

  it("keeps the image's OCR lines in the answer it retains", async () => {
    const { fake } = calls(wire());
    const ocr = printed([
      ["Vitamin C (as ascorbic acid)", "90 mg"],
      ["Zinc", "11 mg"],
    ]);

    const answer = await transcribedAnswer({ calls: fake, ocr, policy });

    expect(JSON.parse(answer).ocrLines).toEqual(ocr.lines);
  });

  it("a later decode confirms every amount against the retained OCR lines, never the saved row numbers", () => {
    // Owner 2026-11-04: a changed parse numbers rows differently, so the row numbers saved with the answer may name
    // other rows. With OCR lines retained, the decode places each amount afresh.
    const saved = (ocrConfirmed: number[], rows: [string, string][]) =>
      JSON.stringify({
        codec: "label-visual-answer/4",
        policy,
        raw: JSON.stringify(wire()),
        ocrConfirmed,
        ocrLines: printed(rows).lines,
        reread: null,
      });

    const zincNotPrinted = saved(
      [0, 1],
      [
        ["Vitamin C (as ascorbic acid)", "90 mg"],
        ["Zinc", ""],
      ],
    );
    const bothPrinted = saved(
      [],
      [
        ["Vitamin C (as ascorbic acid)", "90 mg"],
        ["Zinc", "11 mg"],
      ],
    );
    const swapped = saved(
      [0, 1],
      [
        ["Vitamin C (as ascorbic acid)", "11 mg"],
        ["Zinc", "90 mg"],
      ],
    );

    expect(decodeVisionResult(task, zincNotPrinted)).toMatchObject({
      status: "review",
      code: "VISION.LABEL_AMOUNT_UNREADABLE",
    });
    expect(decodeVisionResult(task, bothPrinted).status).toBe("candidate");
    expect(decodeVisionResult(task, swapped)).toMatchObject({
      status: "review",
      code: "VISION.LABEL_AMOUNT_UNREADABLE",
    });
  });

  it("is a setup of its own: its fingerprint differs from label-visual-wire/3", () => {
    const base = {
      settings: { provider: "openai", model: "m", reasoningEffort: "medium" },
      executable: "/bin/codex",
      codexHome: "/tmp/codex",
      workRoot: "/tmp/work",
      runtimeProfileVersion: "p/1",
      timeoutMs: 1000,
      extractionProtocol: "label-extraction/1",
    };
    const v3 = CodexVisionModel.describe({ ...base, visualProtocol: "label-visual-wire/3" });
    const v4 = CodexVisionModel.describe({ ...base, visualProtocol: "label-visual-wire/4" });

    expect(v4.configFingerprint).not.toBe(v3.configFingerprint);
    expect(v4.extractionProtocol).toBe("label-extraction/1");
  });
});
