import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";

/**
 * Owner 2026-11-07 (amazon.in pages, KAN-243): Indian medicines and Ayurvedic products print their composition as
 * "Each sugar coated tablet contains: Vitamin A I.P. 5000IU, …" (Supradyn), "Each 10 g contains: Isabgol 10 g"
 * (Dabur), "Each 100 ml Juice/Swaras Contains: Jamun 2.4 g, …" (Krishna's). It introduces the dosed composition, not
 * an allergen statement ("Contains: Milk, Soy").
 */
export const COMPOSITION_CLAUSE = /\beach\b[^.:;\n]{0,60}?\bcontains?\s*:/gi;

/** A heading that is only the composition clause ("Each 10 g contains:"), left out as label structure. */
export function compositionHeading(text: string): boolean {
  const clause = new RegExp(COMPOSITION_CLAUSE.source, "i").exec(text.trim());
  return !!clause && clause.index === 0 && clause[0].length >= text.trim().length - 1;
}

/** The answer reads a composition: a formula column or an excluded heading prints "Each … contains:". */
export function readsComposition(candidate: LabelTextCandidate): boolean {
  const headings = [
    ...(candidate.formula?.columns ?? []).map((column) => column.heading?.text ?? ""),
    ...candidate.exclusions
      .filter((exclusion) => exclusion.reason === "heading")
      .map((exclusion) => exclusion.quote.text),
  ];
  return headings.some((text) => new RegExp(COMPOSITION_CLAUSE.source, "i").test(text));
}
