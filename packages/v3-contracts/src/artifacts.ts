import { z } from "zod";

// Opaque, transport-safe identities. Production entry IDs retain their UUIDs;
// these are never URLs, paths, display names or provider credentials.
export const ExecutionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const VersionTagSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/);
export const ObjectKeySchema = z.string().min(1).max(1024)
  .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine(key => key.split("/").every(part => part !== "." && part !== ".."), "Unsafe object key");

export const ProducerSchema = z.strictObject({
  operationId: ExecutionIdSchema,
  module: VersionTagSchema,
  implementationVersion: VersionTagSchema,
});
export const ObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: ExecutionIdSchema,
  observationId: ExecutionIdSchema,
  brandId: ExecutionIdSchema,
  sourceId: ExecutionIdSchema,
  listingId: ExecutionIdSchema,
  // null means listing-level evidence; never silently mix a variant into it.
  variantId: ExecutionIdSchema.nullable(),
});
const base = {
  schemaVersion: z.literal(1),
  artifactId: ExecutionIdSchema,
  observationId: ExecutionIdSchema,
  sourceId: ExecutionIdSchema,
  listingId: ExecutionIdSchema,
  variantId: ExecutionIdSchema.nullable(),
  sha256: Sha256Schema,
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  objectKey: ObjectKeySchema,
  producer: ProducerSchema,
};
const imageType = z.enum(["image/png", "image/jpeg", "image/webp"]);
export const SourceImageSchema = z.strictObject({ ...base, kind: z.literal("source-image"), mediaType: imageType });
export const PdfPageSchema = z.strictObject({ ...base, kind: z.literal("pdf-page"), mediaType: imageType,
  parentArtifactId: ExecutionIdSchema, pageIndex: z.number().int().nonnegative().max(1000000) });
export const ArtifactRefSchema = z.discriminatedUnion("kind", [
  SourceImageSchema, PdfPageSchema,
  z.strictObject({ ...base, kind: z.literal("source-pdf"), mediaType: z.literal("application/pdf") }),
  z.strictObject({ ...base, kind: z.literal("source-html"), mediaType: z.literal("text/html") }),
  z.strictObject({ ...base, kind: z.literal("text"), mediaType: z.literal("text/plain") }),
  z.strictObject({ ...base, kind: z.literal("result-json"), mediaType: z.literal("application/json") }),
]).refine(file => file.kind !== "pdf-page" || file.parentArtifactId !== file.artifactId, "A PDF page cannot parent itself");
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type Observation = z.infer<typeof ObservationSchema>;

/** Relation check only: byte existence, hash and PDF page bounds are resolver duties. */
export function assertArtifactBelongsTo(raw: unknown, owner: Observation): ArtifactRef {
  const artifact = ArtifactRefSchema.parse(raw), observation = ObservationSchema.parse(owner);
  for (const field of ["observationId", "sourceId", "listingId", "variantId"] as const)
    if (artifact[field] !== observation[field]) throw Error("ARTIFACT.OWNERSHIP_CONFLICT");
  return artifact;
}
