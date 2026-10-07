import type { LabelTextCandidateSchema } from "@crawl-automation/v3-contracts";
import type { z } from "zod";

type Candidate = z.infer<typeof LabelTextCandidateSchema>;
type Exclusion = Candidate["exclusions"][number];

/** Text left out among or below the Facts rows that carries no formula content. */
export function rowExclusionAllowed(exclusion: Exclusion, candidate: Candidate): boolean {
  return (
    (exclusion.reason === "footnote" && belowFactsRows(exclusion, candidate)) ||
    (["noise", "footnote"].includes(exclusion.reason) && rowConnector(exclusion, candidate))
  );
}

/** The Facts rows' own quotes: names, amounts and daily values. */
function rowSpan(candidate: Candidate): { first: number; last: number } | null {
  const present = (candidate.formula?.columns ?? []).flatMap((column) =>
    column.rows.flatMap((row) => [row.name, row.amount, row.dailyValue].filter((quote) => !!quote)),
  );
  if (present.length === 0) {
    return null;
  }
  return {
    first: Math.min(...present.map((quote) => quote.start)),
    last: Math.max(...present.map((quote) => quote.end)),
  };
}

export const DOSE = /\d[\d,.]*\s*(?:mg|mcg|µg|μg|g|iu|cfu|ml|%|billion|million)\b/i;
/** Herb extract notes: "(E) Extraction rate 140 mg herb per 0.7 ml", "Dry herb / menstruum ratio: 1 : 5". */
const EXTRACT_NOTE = /extraction\s+rate|herb\s+per|\bratio\b/i;

/**
 * Owner 2026-10-07: a footnote printed below the last Facts row ("(O) Certified Organic", "Not a significant source
 * of…", "(E) Extraction rate 140 mg herb per 0.7 ml") explains the table and may be left out; the formula need not be
 * perfect. A footnote with any other amount ("Supplying 300 mg") may be a row, and one above or among the rows still
 * needs Review.
 */
function belowFactsRows(exclusion: Exclusion, candidate: Candidate): boolean {
  const span = rowSpan(candidate);
  const text = exclusion.quote.text;
  return (
    !candidate.formula?.drugFacts &&
    !!span &&
    exclusion.quote.start >= span.last &&
    (!DOSE.test(text) || EXTRACT_NOTE.test(text))
  );
}

const ROW_CONNECTOR =
  /^(?:(?:which\s+)?(?:typically\s+)?(?:provid(?:es|ing)|supplying|yields|consisting\s+of|comprising(?:\s+of)?|blend\s+of|of|&|and)\s*:?)$/i;

/** Owner 2026-10-07: a bare linking word among the Facts rows ("providing:", "consisting of:", "&") carries no content. */
function rowConnector(exclusion: Exclusion, candidate: Candidate): boolean {
  const span = rowSpan(candidate);
  const { start, end } = exclusion.quote;
  return (
    !!span &&
    start >= span.first &&
    end <= span.last &&
    ROW_CONNECTOR.test(exclusion.quote.text.trim())
  );
}
