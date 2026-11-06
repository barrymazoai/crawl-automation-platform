import { MARKETPLACE_LABEL_FORMATS, type LabelFormatId } from "@crawl-automation/v3-contracts";
import { transcriptCandidate } from "./protocol/label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./protocol/label-transcript-wire.js";

/** KAN-243 test helpers: an Indian label panel as the vision copy prints it, and what the parser reads from it. */
export const INDIA = MARKETPLACE_LABEL_FORMATS["amazon.in"] ?? [];
export const US: LabelFormatId[] = ["us-facts/1"];
export const policy = { allowNoOtherIngredientsSection: true };
export const row = (...cells: string[]) => ({ cells, indent: 0, bold: false });

export function wire(panel: {
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

/** The candidate a readable copy gives; a test fails on a reason. */
export function candidateOf(result: ReturnType<typeof transcriptCandidate>) {
  if ("reason" in result) {
    throw new Error(result.reason);
  }
  return result.candidate;
}

export const text = (quoted: { text: string } | null | undefined) => quoted?.text ?? null;

export function rowsOf(result: ReturnType<typeof transcriptCandidate>) {
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
