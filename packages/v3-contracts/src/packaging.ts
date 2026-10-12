import { z } from "zod";
import { assertArtifactBelongsTo, ArtifactRefSchema, ObservationSchema } from "./artifacts.js";
import { LabelQuoteSchema } from "./label-extraction.js";

/** Packaging facts are not formula rows, product composition or an ingestion receipt. */
export const PackagingClaimSchema = z.strictObject({
  document: ArtifactRefSchema,
  field: z.enum(["servingSize", "servingsPerContainer", "packMention"]),
  value: z.string().min(1).max(500),
  quote: LabelQuoteSchema,
});
export type PackagingClaim = z.infer<typeof PackagingClaimSchema>;
const words = (text: string) => text.replace(/\s+/gu, " ").trim();
const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
};
/**
 * Owner 2026-10-08: serving sizes that differ only in format are one value ("5 g" / "5g", "2 Drops" / "2 drops",
 * "approx." / "approx", "2.0 grams" / "2 grams"). Owner 2026-10-09: so are a "(s)" plural marker, singular/plural
 * unit words and a spelled-out count ("2 Caplet(s)" / "Two Caplets", "1 Scoop(s)" / "1 Scoop (22g)" on GNC).
 */
export function servingSizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\((?:e?s)\)/gu, "")
    .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gu, (word) => NUMBER_WORDS[word] ?? word)
    .replace(/\b([a-z]{2,})ies\b/gu, "$1y")
    .replace(/\b([a-z]*(?:x|ss|sh|ch))es\b/gu, "$1")
    .replace(/\b([a-z]{2,}[^\W\ds])s\b/gu, "$1")
    .replace(/(\d)\.0+(?!\d)/gu, "$1")
    .replace(/(?<!\d)[.,;:()[\]]|[.,;:()[\]](?!\d)/gu, " ")
    .replace(/(\d)\s+(?=[a-zµμ])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}
const resolvedField = z.strictObject({ status: z.enum(["unknown", "observed", "conflict"]),
  value: z.string().min(1).max(500).nullable(), claims: z.array(PackagingClaimSchema).max(500) });
export const PackagingFactsSchema = z.strictObject({
  codec: z.literal("packaging-facts/1"), observation: ObservationSchema,
  // A title containing Pack is not evidence of either a bundle or a count of containers.
  productComposition: z.literal("unknown"), containerCount: z.null(),
  servingSize: resolvedField, servingsPerContainer: resolvedField,
  unresolvedPackMentions: z.array(PackagingClaimSchema).max(500),
  warnings: z.array(z.enum(["PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT", "PACKAGING.PACK_MEANING_UNRESOLVED"])),
  blockingIssues: z.array(z.literal("PACKAGING.SERVING_SIZE_CONFLICT")),
}).superRefine((facts, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Inconsistent packaging evidence" });
  for (const field of ["servingSize", "servingsPerContainer"] as const) {
    const resolved = facts[field];
    // Facts written before 2026-10-08 grouped serving sizes by exact words; newer ones by servingSizeKey.
    const keys = field === "servingSize" ? [words, servingSizeKey] : [words];
    const consistent = keys.some((key) => {
      const first = new Map<string, string>();
      for (const claim of resolved.claims) if (!first.has(key(claim.value))) first.set(key(claim.value), words(claim.value));
      const values = [...first.values()];
      return resolved.status === (values.length === 0 ? "unknown" : values.length === 1 ? "observed" : "conflict") &&
        resolved.value === (values.length === 1 ? values[0] : null);
    });
    if (!consistent || resolved.claims.some(c => c.field !== field)) invalid();
  }
  for (const claim of [...facts.servingSize.claims, ...facts.servingsPerContainer.claims, ...facts.unresolvedPackMentions]) {
    try { assertArtifactBelongsTo(claim.document, facts.observation); } catch { invalid(); }
    if (claim.quote.end - claim.quote.start !== claim.quote.text.length) invalid();
  }
  if (facts.unresolvedPackMentions.some(c => c.field !== "packMention")) invalid();
  const warnings = [...(facts.servingsPerContainer.status === "conflict" ? ["PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT"] : []),
    ...(facts.unresolvedPackMentions.length ? ["PACKAGING.PACK_MEANING_UNRESOLVED"] : [])];
  if (JSON.stringify(facts.warnings) !== JSON.stringify(warnings) || JSON.stringify(facts.blockingIssues) !==
      JSON.stringify(facts.servingSize.status === "conflict" ? ["PACKAGING.SERVING_SIZE_CONFLICT"] : [])) invalid();
});
export type PackagingFacts = z.infer<typeof PackagingFactsSchema>;
