import {
  LabelImageCandidateSchema,
  US_FACTS,
  labelFormatsOfCandidate,
  type LabelFormatId,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { formatPanel, type FormatPanel } from "../../label/transcript/format-panel.js";
import { isAmountCell, servingLine } from "../../label/transcript/transcript-cells.js";
import { marketRules } from "../../label/markets/market-rules.js";
import { printsPairedRow } from "../../label/transcript/paired-rows.js";
import { joinPanelReads } from "./label-transcript-join.js";
import {
  parseTranscriptRows,
  type ParsedPanel,
  type ParsedRow,
} from "../../label/transcript/transcript-rows.js";
import type { TranscriptRow } from "../../label/transcript/html-transcript.js";
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
  copied: LabelTranscriptWire,
  policy: Required<LabelIngredientPresencePolicy>,
  formats: readonly LabelFormatId[] = [US_FACTS],
): TranscriptCandidate {
  const wire = marketRules(formats).copyWire(copied, formats);
  const read = readPanels(wire, formats);
  if ("reason" in read) {
    return { reason: read.reason };
  }
  const { parsed, column } = read;
  const heading = wire.otherIngredientsHeading?.trim();
  const body = wire.otherIngredients?.trim();
  const block = heading && body ? field(body) : null;
  const result = LabelImageCandidateSchema.safeParse({
    codec: "label-extraction/1",
    formula: {
      drugFacts: null,
      servingSize: optionalField(parsed.servingSize),
      servingsPerContainer: optionalField(parsed.servingsPerContainer),
      columns: [column],
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
    ...labelFormatsOfCandidate(formats),
  });
  return result.success ? { candidate: result.data, block } : { reason: "not a label answer" };
}

type Panel = LabelTranscriptWire["panels"][number];

/**
 * The one panel's rows and its formula column, or why the rules cannot read it. KAN-243: a non-US format reshapes the
 * panel first; the US panel is read exactly as before.
 */
type Reason = { reason: string };

function readPanel(
  wire: LabelTranscriptWire,
  formats: readonly LabelFormatId[],
): Reason | { parsed: ParsedPanel; column: ReturnType<typeof formulaColumn> } {
  const read = panelRows(wire, formats);
  if ("reason" in read) {
    return read;
  }
  const { panel, shaped, rows } = read;
  const parsed = parseTranscriptRows(rows);
  if (!parsed.rows.length) {
    return { reason: "no rows" };
  }
  parsed.servingSize ??= shaped?.servingSize ?? null;
  parsed.servingsPerContainer ??= shaped?.servingsPerContainer ?? null;
  return { parsed, column: formulaColumn(panel, shaped, parsed) };
}

/** One panel; or, where the market joins them, two panels of one label read as one formula. */
function readPanels(wire: LabelTranscriptWire, formats: readonly LabelFormatId[]) {
  const read = readPanel(wire, formats);
  if (!("reason" in read) || !read.reason.startsWith("panels: ") || !joins(wire, formats)) {
    return read;
  }
  const [first, second, ...more] = selectedPanels(wire, formats).map((panel) =>
    readPanel({ ...wire, panels: [panel] }, formats),
  );
  if (!first || !second || more.length || "reason" in first || "reason" in second) {
    return read;
  }
  return joinPanelReads(first, second) ?? read;
}

const joins = (wire: LabelTranscriptWire, formats: readonly LabelFormatId[]) =>
  wire.panels.length > 1 && marketRules(formats).joinsPanels;

/** The rows the parser reads; a value cell the headers do not place must be the only amount in its row. */
function panelRows(
  wire: LabelTranscriptWire,
  formats: readonly LabelFormatId[],
): Reason | { panel: Panel; shaped: FormatPanel | null; rows: TranscriptRow[] } {
  const panel = onePanel(wire, formats);
  if (typeof panel === "string") {
    return { reason: panel };
  }
  const shaped = formatPanel(panel, formats);
  if (shaped && "reason" in shaped) {
    return { reason: shaped.reason };
  }
  const rows = shaped?.rows ?? usRows(panel);
  const several = (row: TranscriptRow) =>
    !row.columns && row.cells.slice(1).filter(isAmountCell).length > 1;
  return rows.some(several) ? { reason: "several amount columns" } : { panel, shaped, rows };
}

/**
 * Owner 2026-11-06: a new copy whose rows print two ingredients side by side ("Iron | 2% | Thiamine (B1) | 180%") is
 * not accepted, since the row rules keep only the first. Asked when an image is read, never when a saved answer is
 * decoded: a saved copy keeps reading as it was accepted.
 */
export function copiesPairedRows(
  wire: LabelTranscriptWire,
  formats: readonly LabelFormatId[] = [US_FACTS],
): boolean {
  const wires = joins(wire, formats)
    ? selectedPanels(wire, formats).map((panel) => ({ ...wire, panels: [panel] }))
    : [wire];
  return wires.some((each) => {
    const read = panelRows(each, formats);
    return !("reason" in read) && read.rows.some((row) => printsPairedRow(row.cells));
  });
}

/**
 * Owner 2026-11-07 (MuscleBlaze Biozyme, Cosmix, AS-IT-IS whey on amazon.in): an amino acid profile printed beside the
 * facts panel is the protein's make-up, not a second facts panel; the facts panel is read alone.
 */
const AMINO_PROFILE = /\bamino\s+acids?\b/i;

/** The panels the copy rules read: amino acid profiles beside a facts panel set aside, then the market's choice. */
function selectedPanels(wire: LabelTranscriptWire, formats: readonly LabelFormatId[]) {
  const shared =
    wire.panels.length > 1
      ? wire.panels.filter((panel) => !AMINO_PROFILE.test(panel.heading ?? ""))
      : wire.panels;
  return marketRules(formats).copyPanels(shared);
}

/** The one panel with no unreadable cell; otherwise why not. */
function onePanel(wire: LabelTranscriptWire, formats: readonly LabelFormatId[]): Panel | string {
  const [panel, ...others] = selectedPanels(wire, formats);
  if (!panel || others.length) {
    return `panels: ${wire.panels.length}`;
  }
  const kept = { ...wire, panels: [panel] };
  return JSON.stringify(kept).includes(UNREADABLE_CELL) ? "unreadable cell" : panel;
}

/**
 * The copied serving lines the parser reads (Serving Size, Servings Per Container), then the table's rows. Owner
 * 2026-11-08 (KAN-243, Luna high copy test): any other line the copy files beside the table ("Recommended usage level:
 * 1-2 servings per day", "8 SHOTS") is no row of the table.
 */
const usRows = (panel: Panel): TranscriptRow[] => [
  ...panel.servingLines
    .map((text) => ({ cells: [text], indent: 0, bold: false, table: 0 }))
    .filter((row) => servingLine(row)),
  ...panel.rows.map((row) => ({ ...row, table: 0 })),
];

function formulaColumn(panel: Panel, shaped: FormatPanel | null, parsed: ParsedPanel) {
  const dailyValueHeading = shaped?.dailyValueHeading;
  return {
    heading: shaped?.amountHeading
      ? field(shaped.amountHeading)
      : columnHeading(panel.columnHeaders),
    ...(dailyValueHeading ? { dailyValueHeading: field(dailyValueHeading) } : {}),
    rows: parsed.rows.map(labelRow),
  };
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
