import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";

type Exclusion = LabelTextCandidate["exclusions"][number];

/** "Serving Size" or "Servings Per Container", printed right before its own field's value. */
export function isFieldPrefix(
  exclusion: Exclusion,
  judged: { candidate: LabelTextCandidate; text: string },
): boolean {
  if (exclusion.reason !== "metadata") {
    return false;
  }
  const value = exclusion.quote.text.trim();
  const formula = judged.candidate.formula;
  const field = /^Serving Size\s*:?$/i.test(value)
    ? formula?.servingSize
    : /^Servings? Per Container\s*:?$/i.test(value)
      ? formula?.servingsPerContainer
      : null;
  if (!field || exclusion.quote.end > field.start) {
    return false;
  }
  return /^\s*:?\s*$/.test(judged.text.slice(exclusion.quote.end, field.start));
}
