import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";

type Exclusion = LabelTextCandidate["exclusions"][number];
const HPUS_NOTE =
  String.raw`The letters? ["“]?HPUS["”]? indicate that ` +
  String.raw`(?:this ingredient|the components?(?:\(s\))? in (?:this|the) product) ` +
  String.raw`(?:is|are) officially (?:included|monographed) in the ` +
  String.raw`Homeopathic Pharmacop(?:oeia|eia) of the United States`;
const DILUTION_NOTE = String.raw`C, K, CK, and X are homeopathic dilutions`;
const FDA_USES_NOTE = String.raw`These ["“]Uses["”] have not been evaluated by the FDA`;
const HOMEOPATHIC_NOTE = new RegExp(
  String.raw`^(?:[*\s]*(?:${HPUS_NOTE}|${DILUTION_NOTE}|${FDA_USES_NOTE})\.?\s*){1,2}$`,
  "i",
);
const TRACE_NOTE = new RegExp(
  String.raw`^\(contains less than (?:than )?[\d⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉.]+` +
    String.raw`(?:[-⁻₋][\d⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+)? mg [a-z ]+\)$`,
  "i",
);

/** A Drug Facts note or active-row connector can be structural without becoming an ingredient. */
export function drugNoteExclusionAllowed(
  exclusion: Exclusion,
  candidate?: LabelTextCandidate,
): boolean {
  const value = exclusion.quote.text.trim();
  if (HOMEOPATHIC_NOTE.test(value) || TRACE_NOTE.test(value)) {
    return true;
  }
  if (exclusion.reason === "metadata") {
    return /^Drug classification\s*:\s*$/i.test(value);
  }
  return (
    exclusion.reason === "noise" && /^and$/i.test(value) && activeRowConnector(exclusion, candidate)
  );
}

function activeRowConnector(exclusion: Exclusion, candidate?: LabelTextCandidate): boolean {
  const quote = exclusion.quote;
  return !!candidate?.formula?.columns.some((column) =>
    column.rows.some(
      (row) =>
        row.name.start <= quote.start &&
        Math.max(row.purpose?.end ?? 0, row.amount?.end ?? 0, row.name.end) >= quote.end,
    ),
  );
}
