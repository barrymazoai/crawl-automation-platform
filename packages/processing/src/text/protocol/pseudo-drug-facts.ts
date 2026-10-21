import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { drugExclusionAllowed } from "./drug-label.js";
import { isolatedIngredientsHeadings } from "./label-headings.js";

type Exclusion = LabelTextCandidate["exclusions"][number];
const ACTIVE_COLUMN =
  /^Active(?:\s+ingredients?(?:\(s\))?)?(?:(?:\s*[:;]\s*|\s+\()in\s+each\s+[^\n)]+\)?)?\s*:?$/i;
const UNIT_HEADING =
  /^in\s+each\s+(?:lozenge|tablet|capsule|caplet|softgel|gummy|teaspoon|drop|spray|dose|packet|sachet)s?\s*:?$/i;

/** Amazon sometimes prints active and inactive Drug Facts clauses without a Drug Facts title. */
export function pseudoDrugFactsContext(candidate: LabelTextCandidate, text: string): boolean {
  const active = /\bactive\s+ingredients?\s*:?/i.exec(text);
  const inactiveAfterActive =
    active &&
    /\binactive(?:\s+ingredients?)?\s*:?/i.test(text.slice(active.index + active[0].length));
  return (
    !!inactiveAfterActive ||
    !!candidate.formula?.columns.some(
      (column) => column.heading && ACTIVE_COLUMN.test(column.heading.text.trim()),
    )
  );
}

/** An inactive clause can follow the quoted active row on the same compressed line. */
export function pseudoInactivePositionAllowed(
  candidate: LabelTextCandidate,
  text: string,
  headingStart: number,
): boolean {
  return (candidate.formula?.columns ?? []).some((column) => {
    const heading = column.heading;
    return (
      !!heading &&
      ACTIVE_COLUMN.test(heading.text.trim()) &&
      heading.end < headingStart &&
      column.rows.some((row) => {
        const end = Math.max(row.name.end, row.amount?.end ?? 0, row.purpose?.end ?? 0);
        return (
          end > heading.end && end <= headingStart && /^\s*$/.test(text.slice(end, headingStart))
        );
      })
    );
  });
}

/** Only structural heading and metadata exclusions get the label-text/6 pseudo panel allowance. */
export function pseudoDrugExclusionAllowed(
  exclusion: Exclusion,
  candidate: LabelTextCandidate,
  text: string,
): boolean {
  const value = exclusion.quote.text.trim();
  if (exclusion.reason === "heading" && /^Ingredients$/i.test(value)) {
    return isolatedIngredientsHeadings(candidate, text, { start: 0, end: text.length }).some(
      (span) => span.start === exclusion.quote.start && span.end === exclusion.quote.end,
    );
  }
  if (!["heading", "metadata"].includes(exclusion.reason)) {
    return false;
  }
  return UNIT_HEADING.test(value) || drugExclusionAllowed(exclusion, text, candidate);
}
