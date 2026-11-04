import {
  LabelImageCandidateSchema,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { isAmountCell } from "../../label/transcript/transcript-cells.js";
import { parseTranscriptRows, type ParsedRow } from "../../label/transcript/transcript-rows.js";
import type { LabelIngredientPresencePolicy } from "./label-ingredient-presence.js";
import {
  UNREADABLE_CELL,
  labelTranscriptProtocol,
  type LabelTranscriptWire,
} from "./label-transcript-wire.js";

type Field = { text: string; evidence: string };
export type TranscriptCandidate =
  { candidate: LabelImageCandidate; block: Field | null } | { reason: string };

const field = (text: string): Field => ({ text, evidence: text });
const AMOUNT_HEADER = /amount|per\s+serving/i;

/**
 * The label answer the copied panel says, by the same fixed rules as a web page's table. A copy those rules cannot
 * read faithfully (several panels or dose columns, an unreadable cell) gives a reason instead, and the image is read
 * with the label protocol as before.
 */
export function transcriptCandidate(
  wire: LabelTranscriptWire,
  policy: Required<LabelIngredientPresencePolicy>,
): TranscriptCandidate {
  const panel = readablePanel(wire);
  if (typeof panel === "string") {
    return { reason: panel };
  }
  const parsed = parseTranscriptRows([
    ...panel.servingLines.map((text) => ({ cells: [text], indent: 0, bold: false, table: 0 })),
    ...panel.rows.map((row) => ({ ...row, table: 0 })),
  ]);
  if (!parsed.rows.length) {
    return { reason: "no rows" };
  }
  const heading = wire.otherIngredientsHeading?.trim();
  const body = wire.otherIngredients?.trim();
  const block = heading && body ? field(body) : null;
  const result = LabelImageCandidateSchema.safeParse({
    codec: "label-extraction/1",
    formula: {
      drugFacts: null,
      servingSize: optionalField(parsed.servingSize),
      servingsPerContainer: optionalField(parsed.servingsPerContainer),
      columns: [{ heading: columnHeading(panel.columnHeaders), rows: parsed.rows.map(labelRow) }],
    },
    otherIngredients: heading && block ? { heading: field(heading), items: [block] } : null,
    formulaComplete: parsed.rows.some((row) => row.amount !== null),
    ingredientsComplete: ingredientsComplete(wire, !!block),
    exclusions: [],
    issues: wire.issues,
    ingredientDeclaration: {
      protocol: labelTranscriptProtocol,
      state: wire.otherIngredientsState,
      wholeLabelVisible: wire.wholeLabelVisible,
      ...policy,
    },
  });
  return result.success ? { candidate: result.data, block } : { reason: "not a label answer" };
}

/** The one panel, when its copy can be read by the rules; otherwise why not. */
function readablePanel(wire: LabelTranscriptWire): LabelTranscriptWire["panels"][number] | string {
  const [panel, ...others] = wire.panels;
  if (!panel || others.length) {
    return `panels: ${wire.panels.length}`;
  }
  if (JSON.stringify(wire).includes(UNREADABLE_CELL)) {
    return "unreadable cell";
  }
  return panel.rows.some((row) => row.cells.slice(1).filter(isAmountCell).length > 1)
    ? "several amount columns"
    : panel;
}

const optionalField = (text: string | null) => (text ? field(text) : null);

function columnHeading(headers: readonly string[]): Field | null {
  const header = headers.find((text) => AMOUNT_HEADER.test(text))?.trim();
  return header ? field(header) : null;
}

function labelRow(row: ParsedRow) {
  const dailyValue = row.dailyValue ?? row.dailyValueMarker ?? null;
  const header = row.kind === "group_header";
  return {
    kind: row.kind,
    name: field(row.name),
    amount: header || !row.amount ? null : field(row.amount),
    dailyValue: header || !dailyValue ? null : field(dailyValue),
    purpose: null,
    amountStatus: header ? "not_applicable" : row.amount ? "printed" : "not_declared",
    parentRowIndex: row.parentRowIndex,
  };
}

function ingredientsComplete(wire: LabelTranscriptWire, listed: boolean): boolean {
  return (
    (wire.otherIngredientsState === "present" && listed) ||
    (wire.otherIngredientsState === "none_printed" && wire.wholeLabelVisible && !listed)
  );
}
