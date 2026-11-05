import { describe, expect, it } from "vitest";
import {
  DefaultKeywordPolicy,
  LABEL_FORMATS,
  LabelImageCandidateSchema,
  MARKETPLACE_LABEL_FORMATS,
  keywordPolicyFor,
  keywordPolicyFormats,
  legacyLabelExtractionSchema,
  LabelImageFieldSchema,
  projectLabelProductCandidate,
  type LabelFormatId,
} from "@crawl-automation/v3-contracts";
import { screenKeywords } from "../keywords/keyword-screen.js";
import { image, observation } from "../testing/vision-fixture.js";
import { decodeTranscriptAnswer } from "./protocol/label-transcript-answer.js";
import { transcriptCandidate } from "./protocol/label-transcript-candidate.js";
import {
  labelTranscriptPrompt,
  labelTranscriptPromptFor,
  labelTranscriptWireSchema,
} from "./protocol/label-transcript-wire.js";
import { transcribedAnswer, type TranscriptCalls } from "./vision-transcript-flow.js";

// KAN-243: real amazon.in labels (docs/plans/KAN-243-india-research.md §2), values as printed.
const INDIA = MARKETPLACE_LABEL_FORMATS["amazon.in"] ?? [];
const US: LabelFormatId[] = ["us-facts/1"];
const policy = { allowNoOtherIngredientsSection: true };
const row = (...cells: string[]) => ({ cells, indent: 0, bold: false });

function wire(panel: {
  heading?: string | null;
  servingLines?: string[];
  columnHeaders?: string[];
  rows: ReturnType<typeof row>[];
}) {
  return labelTranscriptWireSchema.parse({
    codec: "label-visual-wire/4",
    panels: [
      {
        heading: panel.heading ?? "Nutritional Information (Approx.)",
        servingLines: panel.servingLines ?? [],
        columnHeaders: panel.columnHeaders ?? [],
        rows: panel.rows,
        footnotes: [],
      },
    ],
    otherIngredientsHeading: "Ingredients:",
    otherIngredients: "Magnesium Citrate, Microcrystalline Cellulose.",
    otherIngredientsState: "present",
    wholeLabelVisible: false,
    issues: [],
  });
}

/** Tata 1mg Magnesium: "Nutrients | Qty./Serving | %RDA", the RDA printed as a bare number. */
const tataMagnesium = wire({
  servingLines: ["Serving Size: 1 Tablet"],
  columnHeaders: ["Nutrients", "Qty./Serving", "%RDA"],
  rows: [row("Energy", "0.3 kcal", "-"), row("Magnesium", "350 mg", "100")],
});

/** The candidate a readable copy gives; a test fails on a reason. */
function candidateOf(result: ReturnType<typeof transcriptCandidate>) {
  if ("reason" in result) {
    throw new Error(result.reason);
  }
  return result.candidate;
}

const text = (quoted: { text: string } | null | undefined) => quoted?.text ?? null;

function rowsOf(result: ReturnType<typeof transcriptCandidate>) {
  const formula = candidateOf(result).formula;
  const column = formula?.columns[0];
  return {
    heading: text(column?.heading),
    dailyValueHeading: text(column?.dailyValueHeading),
    servingSize: text(formula?.servingSize),
    servingsPerContainer: text(formula?.servingsPerContainer),
    rows: (column?.rows ?? []).map((read) => [
      text(read.name),
      text(read.amount),
      text(read.dailyValue),
    ]),
  };
}

describe("Indian label formats (KAN-243)", () => {
  it("reads the Nutritional Information table by its printed headers; the US rules alone do not", () => {
    expect(transcriptCandidate(tataMagnesium, policy, US)).toEqual({
      reason: "several amount columns",
    });
    expect(rowsOf(transcriptCandidate(tataMagnesium, policy, INDIA))).toEqual({
      heading: "Qty./Serving",
      dailyValueHeading: "%RDA",
      servingSize: "1 Tablet",
      servingsPerContainer: null,
      rows: [
        ["Energy", "0.3 kcal", "-"],
        ["Magnesium", "350 mg", "100"],
      ],
    });
  });

  it("takes the per-serving column over per 100 g, the pack count, and RDA not established", () => {
    // HK Vitals: Qty/Serving, Qty/100g and %RDA; "**" marks a nutrient without an RDA.
    const read = transcriptCandidate(
      wire({
        servingLines: ["Serving Size: 1 Tablet (1.3 g)", "Servings Per Pack: 60"],
        columnHeaders: ["Nutrients", "Qty/Serving", "Qty/100g", "%RDA*"],
        rows: [
          row("Nutrients", "Qty/Serving", "Qty/100g", "%RDA*"),
          row("Vitamin C", "80 mg", "6153.8 mg", "100"),
          row("Biotin", "40 mcg", "3076.9 mcg", "100"),
          row("Grape Seed Extract", "50 mg", "3846.2 mg", "**"),
          row("*RDA values based on ICMR-NIN 2020"),
        ],
      }),
      policy,
      INDIA,
    );
    expect(rowsOf(read)).toEqual({
      heading: "Qty/Serving",
      dailyValueHeading: "%RDA*",
      servingSize: "1 Tablet (1.3 g)",
      servingsPerContainer: "60",
      rows: [
        ["Vitamin C", "80 mg", "100"],
        ["Biotin", "40 mcg", "100"],
        ["Grape Seed Extract", "50 mg", "**"],
      ],
    });
  });

  it("reads the first of two RDA columns, with headers that leave out the name column", () => {
    // HealthyHey: RDA for men and for women.
    const read = transcriptCandidate(
      wire({
        columnHeaders: ["Per Serving", "%RDA (Men)", "%RDA (Women)"],
        rows: [row("Vitamin D3", "15 mcg", "100", "100"), row("Zinc", "8.5 mg", "50", "71")],
      }),
      policy,
      INDIA,
    );
    expect(rowsOf(read)).toMatchObject({
      heading: "Per Serving",
      dailyValueHeading: "%RDA (Men)",
      rows: [
        ["Vitamin D3", "15 mcg", "100"],
        ["Zinc", "8.5 mg", "50"],
      ],
    });
  });

  it("reads a Composition list as the formula of the serving it names", () => {
    // Kapiva Shilajit: "Each 1g contains: Shilajit (Asphaltum) Exd. 333.33mg".
    const read = transcriptCandidate(
      wire({
        heading: "Composition",
        servingLines: ["Each 1g contains:"],
        rows: [row("Shilajit (Asphaltum) Exd.", "333.33mg"), row("Excipients", "q.s.")],
      }),
      policy,
      INDIA,
    );
    expect(rowsOf(read)).toMatchObject({
      servingSize: "1g",
      dailyValueHeading: null,
      rows: [
        ["Shilajit (Asphaltum) Exd.", "333.33mg", null],
        ["Excipients", null, null],
      ],
    });
  });

  it("does not read raw herb quantities a classical formulation is prepared from", () => {
    // Dabur Chyawanprash: "Each 100g is prepared from: Amla 2.5 g …".
    const read = transcriptCandidate(
      wire({
        heading: "Composition",
        servingLines: ["Each 100g is prepared from:"],
        rows: [row("Amla", "2.5 g")],
      }),
      policy,
      INDIA,
    );
    expect(read).toEqual({
      reason: "prepared-from list: raw herb quantities, not the product's contents",
    });
  });

  it("falls back when a row cannot be placed under its headers", () => {
    const read = transcriptCandidate(
      wire({
        columnHeaders: ["Nutrients", "Qty./Serving", "%RDA"],
        rows: [row("Zinc", "8 mg", "73", "x", "y")],
      }),
      policy,
      INDIA,
    );
    expect(read).toEqual({
      reason: "row not aligned with the column headers: Zinc | 8 mg | 73 | x | y",
    });
  });

  it("reads a US Supplement Facts panel on amazon.in exactly as the US rules do", () => {
    const facts = wire({
      heading: "Supplement Facts",
      servingLines: ["Serving Size 1 Capsule"],
      columnHeaders: ["Amount Per Serving", "% Daily Value"],
      rows: [row("Vitamin C (as ascorbic acid)", "90 mg", "100%"), row("Zinc", "11 mg", "100%")],
    });
    expect(transcriptCandidate(facts, policy, INDIA)).toEqual(
      transcriptCandidate(facts, policy, US),
    );
  });
});

describe("US reading unchanged (KAN-243)", () => {
  it("keeps the US keyword policy, prompt and answer byte for byte", async () => {
    expect(keywordPolicyFor(undefined)).toBe(DefaultKeywordPolicy);
    expect(keywordPolicyFor(US)).toBe(DefaultKeywordPolicy);
    expect(LABEL_FORMATS["us-facts/1"].keywords).toEqual(DefaultKeywordPolicy.keywords);
    expect(labelTranscriptPromptFor(undefined)).toBe(labelTranscriptPrompt);
    expect(labelTranscriptPromptFor(US)).toBe(labelTranscriptPrompt);
    const usWire = wire({
      heading: "Supplement Facts",
      columnHeaders: ["Amount Per Serving", "% Daily Value"],
      rows: [row("Zinc", "11 mg", "100%")],
    });
    const ocr = printed([["Zinc", "11 mg 100%"]]);
    const before = await transcribedAnswer({ calls: fixed(usWire), ocr, policy });
    const after = await transcribedAnswer({ calls: fixed(usWire), ocr, policy, formats: US });
    expect(after).toBe(before);
    expect(JSON.parse(before)).not.toHaveProperty("formats");
  });

  it("keeps the US candidate without a percentage header", () => {
    const usWire = wire({
      heading: "Supplement Facts",
      columnHeaders: ["Amount Per Serving"],
      rows: [row("Zinc", "11 mg", "100%")],
    });
    const candidate = candidateOf(transcriptCandidate(usWire, policy));
    expect(candidate.formula?.columns[0]).not.toHaveProperty("dailyValueHeading");
  });
});

describe("the formats travel with the image (KAN-243)", () => {
  it("selects the Indian table by its own words, and names the formats in the selection", () => {
    const text =
      "Nutritional Information (Approx.)\nNutrients Qty./Serving %RDA\nMagnesium 350 mg 100";
    const base = { observation, image, ocrOperationId: "ocr-1", text };
    expect(screenKeywords(base).status).toBe("not_matched");
    const selected = screenKeywords(base, keywordPolicyFor(INDIA));
    expect(selected.status).toBe("matched");
    expect(selected.matchedKeywords).toEqual(["Nutritional Information", "RDA"]);
    expect(keywordPolicyFormats(selected.policy)).toEqual(INDIA);
  });

  it("asks the copy in the formats and decodes the answer in them later", async () => {
    expect(labelTranscriptPromptFor(INDIA)).toContain('"Qty./Serving", "Qty/100g", "%RDA"');
    expect(labelTranscriptPromptFor(INDIA).startsWith(labelTranscriptPrompt)).toBe(true);
    const ocr = printed([
      ["Energy", "0.3 kcal -"],
      ["Magnesium", "350 mg 100"],
    ]);
    const answer = await transcribedAnswer({
      calls: fixed(tataMagnesium),
      ocr,
      policy,
      formats: INDIA,
    });
    expect(JSON.parse(answer).formats).toEqual(INDIA);
    const decoded = decodeTranscriptAnswer(answer);
    expect(decoded.codes).toEqual([]);
    expect(decoded.status).toBe("candidate");
    expect(decoded.candidate.formula?.columns[0]?.dailyValueHeading?.text).toBe("%RDA");
    expect(decoded.candidate.formula?.columns[0]?.rows[1]?.dailyValue?.text).toBe("100");
  });

  it("keeps the printed percentage header through the collected label, never in old model formats", () => {
    const candidate = LabelImageCandidateSchema.parse(
      candidateOf(transcriptCandidate(tataMagnesium, policy, INDIA)),
    );
    const projected = projectLabelProductCandidate("source-1", candidate);
    expect(projected.formula?.columns[0]?.dailyValueHeading).toEqual({
      text: "%RDA",
      sourceId: "source-1",
      citation: { kind: "image", evidence: "%RDA" },
    });
    const legacy = legacyLabelExtractionSchema(LabelImageFieldSchema);
    expect(legacy.safeParse(candidate).success).toBe(false);
  });
});

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
    { text: amount, polygon: at(300, index * 20) },
  ]);
  return { text: lines.map((line) => line.text).join("\n"), lines };
}

function fixed(transcript: unknown): TranscriptCalls {
  return {
    transcribe: async () => JSON.stringify(transcript),
    reread: async () => JSON.stringify({ rows: [] }),
    label: async () => "label-visual-answer/3 envelope",
  };
}
