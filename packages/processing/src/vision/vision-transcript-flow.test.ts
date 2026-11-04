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

describe("transcribed image reading (owner 2026-11-04)", () => {
  it("keeps the code-parsed copy when the OCR text prints every amount", async () => {
    const { fake, made } = calls(wire());

    const answer = await transcribedAnswer({
      calls: fake,
      ocrText: "Vitamin C 90 mg 100% Zinc 11mg 100%",
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

  it("re-reads only the rows the OCR does not show, and keeps the copy when the re-read agrees", async () => {
    const reread = { rows: [{ name: "Zinc", amountCells: ["11 mg"] }] };
    const { fake, made } = calls(wire(), reread);

    const answer = await transcribedAnswer({ calls: fake, ocrText: "Vitamin C 90 mg", policy });

    expect(made).toEqual(["transcribe", "reread:Zinc"]);
    expect(decodeVisionResult(task, answer).status).toBe("candidate");
  });

  it("never takes '11 mg' from a longer printed number such as '111 mg'", async () => {
    const reread = { rows: [{ name: "Zinc", amountCells: ["11 mg"] }] };
    const { fake, made } = calls(wire(), reread);

    await transcribedAnswer({ calls: fake, ocrText: "Vitamin C 90 mg Zinc 111 mg", policy });

    expect(made).toEqual(["transcribe", "reread:Zinc"]);
  });

  it("reads the image with the label protocol when the re-read gives another amount", async () => {
    const reread = { rows: [{ name: "Zinc", amountCells: ["1.1 mg"] }] };
    const { fake, made } = calls(wire(), reread);

    const answer = await transcribedAnswer({ calls: fake, ocrText: "Vitamin C 90 mg", policy });

    expect(made).toEqual(["transcribe", "reread:Zinc", "label"]);
    expect(answer).toBe("label-visual-answer/3 envelope");
  });

  it("reads the image with the label protocol when the copy cannot be parsed faithfully", async () => {
    const twoColumns = wire([row("Vitamin C", "90 mg", "180 mg", "100%")]);
    const unreadable = wire([row("Vitamin C", "9[UNREADABLE] mg", "100%")]);
    const twoPanels = { ...wire(), panels: [...wire().panels, ...wire().panels] };

    for (const transcript of [twoColumns, unreadable, twoPanels, { not: "a transcript" }]) {
      const { fake, made } = calls(transcript);
      await transcribedAnswer({ calls: fake, ocrText: "Vitamin C 90 mg", policy });
      expect(made).toEqual(["transcribe", "label"]);
    }
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
