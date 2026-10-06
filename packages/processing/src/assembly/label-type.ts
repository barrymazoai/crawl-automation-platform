import type { LabelCollectedProduct, LabelType } from "@crawl-automation/v3-contracts";
import type { Provenance, VerifiedLabelSource } from "./merge-state.js";

const HEADING = /\b(supplement|nutrition|drug)\s+facts\b/gi;
const TYPES: Record<string, LabelType> = {
  supplement: "supplement_facts",
  nutrition: "nutrition_facts",
  drug: "drug_facts",
};

/** The panel heading that applies to a formula: the last one printed before it, else the first anywhere. */
function headingType(text: string, before = text.length): LabelType | null {
  const matches = [...text.matchAll(HEADING)];
  const preceding = matches.filter((match) => (match.index ?? 0) < before).at(-1);
  const word = (preceding ?? matches[0])?.[1]?.toLowerCase();
  return word ? (TYPES[word] ?? null) : null;
}

/** Printed headings in an image answer: its quoted exclusions and column headings, then the OCR keyword screen. */
function imageType(source: Extract<Provenance, { kind: "image" }>): LabelType | null {
  const { candidate } = source;
  const printed = [
    ...candidate.exclusions.map((exclusion) => exclusion.quote.text),
    ...(candidate.formula?.columns ?? []).flatMap((column) =>
      column.heading ? [column.heading.text] : [],
    ),
  ].join("\n");
  return (
    headingType(printed) ?? headingType(source.record.input.selection.matchedKeywords.join("\n"))
  );
}

/**
 * Owner 2026-10-06: record whether the formula came from Supplement, Nutrition or Drug Facts. Read from the printed
 * heading in the formula's own source; `none` without a formula, `unknown` when no heading was printed or read.
 */
export function labelTypeOf(
  formula: LabelCollectedProduct["formula"],
  sources: { provenance: Provenance[]; entries: VerifiedLabelSource[] },
): LabelType {
  if (!formula) {
    return "none";
  }
  if (formula.drugFacts) {
    return "drug_facts";
  }
  return formulaSourceType(formula, sources) ?? "unknown";
}

function formulaSourceType(
  formula: NonNullable<LabelCollectedProduct["formula"]>,
  sources: { provenance: Provenance[]; entries: VerifiedLabelSource[] },
): LabelType | null {
  const first = formula.columns[0]?.rows[0]?.name;
  const source = sources.provenance.find((entry) => entry.id === first?.sourceId);
  if (!first || !source) {
    return null;
  }
  if (source.kind === "image") {
    return imageType(source);
  }
  const entry = sources.entries.find((verified) => verified.id === source.id);
  const text = entry?.kind === "text" ? entry.fullText : "";
  return headingType(text, first.citation.kind === "text" ? first.citation.start : text.length);
}
