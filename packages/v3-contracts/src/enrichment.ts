import { z } from "zod";
import { ExecutionIdSchema, ObjectKeySchema, ObservationSchema, Sha256Schema, VersionTagSchema } from "./artifacts.js";

/** Bump when the prompt/output contract changes; existing rows for the old protocol are kept, not reused. */
export const ENRICHMENT_PROTOCOL = "product-enrichment/1";

export const EnrichmentInputSchema = z.strictObject({ schemaVersion: z.literal(1), collectionOperationId: ExecutionIdSchema });
export type EnrichmentInput = z.infer<typeof EnrichmentInputSchema>;

export const DosageFormSchema = z.enum(["capsule", "softgel", "tablet", "chewable", "gummy", "powder", "liquid", "drops", "spray", "bar", "lozenge", "other", "unknown"]);
/** Model output. Every value is derived from the product's own title, formula and ingredients; nothing is guessed from brand lore. */
export const EnrichmentCandidateSchema = z.strictObject({
  unifiedName: z.string().trim().min(1).max(500),
  baseName: z.string().trim().min(1).max(300),
  form: DosageFormSchema,
  variant: z.strictObject({
    count: z.number().int().positive().max(100000).nullable(),
    size: z.strictObject({ value: z.number().positive().max(1000000), unit: z.string().trim().min(1).max(20) }).nullable(),
    flavor: z.string().trim().min(1).max(100).nullable(),
    strength: z.string().trim().min(1).max(100).nullable(),
  }),
  healthFunctions: z.array(z.string().trim().min(1).max(100)).max(12),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(1000).nullable(),
});
export type EnrichmentCandidate = z.infer<typeof EnrichmentCandidateSchema>;

export const EnrichmentRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), codec: z.literal("product-enrichment/1"),
  enrichmentId: Sha256Schema, protocol: z.literal(ENRICHMENT_PROTOCOL),
  listingId: z.string().min(1).max(200), formulaHash: Sha256Schema,
  collectionOperationId: ExecutionIdSchema, observation: ObservationSchema,
  provider: VersionTagSchema, createdAt: z.iso.datetime(),
  input: z.strictObject({ title: z.string().max(4000).nullable(), url: z.string().max(4096).nullable(), promptSha256: Sha256Schema }),
  candidate: EnrichmentCandidateSchema,
  evidenceKey: ObjectKeySchema,
});
export type EnrichmentRecord = z.infer<typeof EnrichmentRecordSchema>;

export const EnrichmentOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("registered"), enrichmentId: Sha256Schema, reused: z.boolean(), candidate: EnrichmentCandidateSchema }),
  z.strictObject({ status: z.literal("review"), reviewId: ExecutionIdSchema, code: z.string().regex(/^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/) }),
]);
export type EnrichmentOutcome = z.infer<typeof EnrichmentOutcomeSchema>;

/** Answer of `inspectExistingFormula`: a current-structure formula already collected for this listing. */
export const ExistingFormulaSchema = z.discriminatedUnion("exists", [
  z.strictObject({ exists: z.literal(false) }),
  z.strictObject({ exists: z.literal(true), operationId: ExecutionIdSchema, observationId: ExecutionIdSchema,
    codec: z.enum(["collected-product/3", "collected-product/4"]), evidenceKey: ObjectKeySchema, recordHash: Sha256Schema, collectedAt: z.iso.datetime() }),
]);
export type ExistingFormula = z.infer<typeof ExistingFormulaSchema>;
export const ExistingFormulaInputSchema = z.strictObject({ schemaVersion: z.literal(1), owner: ObservationSchema });
