import type { TextInput } from "@crawl-automation/v3-contracts";
import { evidenceLines, type EvidenceLine } from "../../text/protocol/evidence-lines.js";
import { Anchors, type Anchor } from "./transcript-anchors.js";
import { htmlTranscript } from "./html-transcript.js";
import {
  parseTranscriptRows,
  splitPrintedList,
  type ParsedPanel,
  type ParsedRow,
} from "./transcript-rows.js";

/**
 * The transcribe-then-parse answer (owner 2026-11-04, docs/spark/2026-11-04-label-transcribe-then-parse-plan.md): a
 * facts panel the page prints as rows is copied from its HTML and parsed in code into the same label-extraction/1 wire
 * answer the text model gives, every field anchored to the exact printed words of a numbered source line. The existing
 * decoder and checks then read it like a model answer. No answer whenever the panel cannot be copied faithfully, so
 * the caller asks the model instead.
 */
export interface TranscriptAttempt {
  answer: string | null;
  /** Why the panel is left to the model; kept for diagnostics and replay reports. */
  reason: string | null;
}

const ALLERGEN = /\b(?:does\s+not\s+contain|contains\s*:|free\s+of|gluten\s+free|allergen)/i;
/** Lines a facts panel prints that are no row, dose or ingredient, with the exclusion reason the protocol knows. */
const EXCLUDED: [RegExp, string][] = [
  [
    /^(?:supplement|nutrition|drug)\s+facts\b|^amount\s*(?:per|\/)\s*serving\b|^%\s*(?:dv|daily\s*value)\b|^(?:other|inactive)\s+ingredients?\s*:?$|^serving\s*size\b|^servings?\s+per\b/i,
    "heading",
  ],
  [/^[*†‡]|daily\s+value|calorie\s+diet|not\s+established/i, "footnote"],
  [ALLERGEN, "allergen"],
  [
    /\b(?:trademark|used\s+under\s+license|registered|patent|manufactured|distributed|made\s+in)\b|[®™]\s+is\s+a/i,
    "marketing",
  ],
  // A cell printed only to say "no amount" ("--", "**", "†") belongs to its row and carries nothing.
  [/^(?:upc|sku|item|lot|exp)\b|^other\s+details$|^\d{8,14}$|^(?:--|—|–|-|\*+|†+|‡+)$/i, "noise"],
  [/^(?:directions|suggested\s+use|warning|caution|keep\s+out)\b/i, "directions"],
];

export function transcriptAnswer(
  input: Pick<TextInput, "range">,
  text: string,
  html: string,
): string | null {
  return transcriptAttempt(input, text, html).answer;
}

export function transcriptAttempt(
  input: Pick<TextInput, "range">,
  text: string,
  html: string,
): TranscriptAttempt {
  const transcript = htmlTranscript(html);
  const panel = transcript ? parseTranscriptRows(transcript.rows) : null;
  if (!transcript || !panel?.rows.length) {
    return { answer: null, reason: transcript ? "no rows" : "no row structure" };
  }
  const anchors = new Anchors(evidenceLines(input, text));
  const formula = anchoredFormula(panel, anchors);
  if (typeof formula === "string") {
    return { answer: null, reason: formula };
  }
  const otherIngredients = other(transcript.otherIngredients, anchors);
  const exclusions = excludedLines(anchors.unused(), anchors.usedRange());
  if (typeof exclusions === "string") {
    return { answer: null, reason: exclusions };
  }
  const answer = JSON.stringify({
    codec: "label-extraction/1",
    formula,
    otherIngredients,
    formulaComplete: panelComplete(panel),
    ingredientsComplete: !!otherIngredients,
    exclusions,
    issues: [],
  });
  return { answer, reason: null };
}

/** The formula with every field anchored, or the reason a field is not printed where the copy says. */
function anchoredFormula(panel: ParsedPanel, anchors: Anchors) {
  const servingSize = panel.servingSize ? anchors.find(panel.servingSize) : null;
  const servingsPerContainer = panel.servingsPerContainer
    ? anchors.find(panel.servingsPerContainer)
    : null;
  const rows = [];
  for (const row of panel.rows) {
    const anchored = anchoredRow(row, anchors);
    if (typeof anchored === "string") {
      return anchored;
    }
    rows.push(anchored);
  }
  return { drugFacts: null, servingSize, servingsPerContainer, columns: [{ heading: null, rows }] };
}

function anchoredRow(row: ParsedRow, anchors: Anchors) {
  const name = anchors.find(row.name);
  if (!name) {
    return `name not printed in a line: ${row.name}`;
  }
  // A group header carries no value; a "--" amount cell is an undeclared amount (its marker is excluded).
  const header = row.kind === "group_header";
  const amount = header ? null : anchors.value(row.amount, name);
  // The amount column's "--" comes first; holding it lets the %DV column's own "--" be the one quoted.
  const amountMarker = row.amountMarker
    ? anchors.find(row.amountMarker, name.fromLine, true)
    : null;
  const dailyValue = header
    ? null
    : anchors.value(row.dailyValue ?? row.dailyValueMarker ?? null, name);
  anchors.release(amountMarker);
  if (amount === undefined || dailyValue === undefined) {
    return `value not printed after its name: ${row.name}`;
  }
  return {
    kind: row.kind,
    name,
    amount,
    dailyValue,
    purpose: null,
    amountStatus: amountStatus(row),
    parentRowIndex: row.parentRowIndex,
  };
}

function amountStatus(row: ParsedRow) {
  if (row.kind === "group_header") {
    return "not_applicable";
  }
  return row.amount ? "printed" : "not_declared";
}

/**
 * Every printed line the formula does not quote, with its reason. A list printed right below an allergen statement
 * ("Does Not Contain" / "Gluten, Soy, Dairy") continues it. Any other unexplained line may be a row or an ingredient
 * the copy missed, so the model reads the panel instead.
 */
function excludedLines(lines: EvidenceLine[], label: { first: number; last: number } | null) {
  const exclusions: { quote: Anchor; reason: string }[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    const last = exclusions[exclusions.length - 1];
    // "<Product> Does Not Contain" / "Gluten, Artificial Colors": one statement, quoted whole so its allergens show.
    if (last?.reason === "allergen" && last.quote.toLine === line.id - 1 && allergenList(text)) {
      last.quote = { ...last.quote, toLine: line.id, text: `${last.quote.text}\n${text}` };
      continue;
    }
    const reason = exclusionReason(
      text,
      !!label && (line.id < label.first || line.id > label.last),
    );
    if (!reason) {
      return `unexplained line: ${text.slice(0, 80)}`;
    }
    exclusions.push({ quote: { fromLine: line.id, toLine: line.id, text }, reason });
  }
  return exclusions;
}

/**
 * Page text wholly above or below the label (a title, a column's own label cell) is metadata, and the checks decide
 * whether it may be left out; anything unexplained among the rows may be a missed row, so the model reads the panel.
 */
function exclusionReason(text: string, aroundLabel: boolean): string | undefined {
  return (
    EXCLUDED.find(([pattern]) => pattern.test(text))?.[1] ?? (aroundLabel ? "metadata" : undefined)
  );
}

/** The list a "Does Not Contain" line leads into: names only, no dose. */
function allergenList(text: string): boolean {
  return !/\d/.test(text) && (splitPrintedList(text).length >= 2 || text.split(/\s+/).length <= 3);
}

function panelComplete(panel: ParsedPanel): boolean {
  return panel.rows.some((row) => row.amount !== null);
}

function other(textValue: string | null, anchors: Anchors) {
  const heading = textValue
    ? anchors.findHeading(/^(?:other|inactive)\s+ingredients?\s*:?/i)
    : null;
  if (!textValue || !heading) {
    return null;
  }
  const items: Anchor[] = [];
  for (const item of splitPrintedList(textValue)) {
    const anchor = anchors.find(item, heading.fromLine);
    if (!anchor) {
      return null;
    }
    items.push(anchor);
  }
  return items.length ? { heading, items } : null;
}
