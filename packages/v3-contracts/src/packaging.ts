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
    const resolved = facts[field], values = [...new Set(resolved.claims.map(c => c.value.replace(/\s+/gu, " ").trim()))];
    if (resolved.status !== (values.length === 0 ? "unknown" : values.length === 1 ? "observed" : "conflict") ||
        resolved.value !== (values.length === 1 ? values[0] : null) || resolved.claims.some(c => c.field !== field)) invalid();
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
