import { z } from "zod";
import { ArtifactRefSchema, ExecutionIdSchema, ObjectKeySchema, ObservationSchema, Sha256Schema, VersionTagSchema, assertArtifactBelongsTo } from "./artifacts.js";

const versions = {
  schemaVersion: z.literal(1),
  implementationVersion: VersionTagSchema,
  policyVersion: VersionTagSchema,
  resultSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  // Hash of public semantic config (model/prompt/options), NEVER credentials.
  configFingerprint: Sha256Schema,
};
const identity = {
  requestId: ExecutionIdSchema, observationId: ExecutionIdSchema,
  operationId: ExecutionIdSchema, module: z.literal("ocr.file"),
};
export const OperationIdentitySchema = z.strictObject({
  ...identity, module: VersionTagSchema, ...versions, inputFingerprint: Sha256Schema,
});
export type OperationIdentity = z.infer<typeof OperationIdentitySchema>;
const inputFields = {
  ...ObservationSchema.shape, ...identity, ...versions,
  file: ArtifactRefSchema.refine(file => file.kind === "source-image" || file.kind === "pdf-page", "OCR requires one image or rendered PDF page"),
};
const belongs = (input: z.infer<typeof OcrUnsignedSchema>) => {
  try { assertArtifactBelongsTo(input.file, { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId,
    brandId: input.brandId, sourceId: input.sourceId, listingId: input.listingId, variantId: input.variantId }); return true; }
  catch { return false; }
};
const OcrUnsignedSchema = z.strictObject(inputFields);
export const OcrInputSchema = z.strictObject({ ...inputFields, inputFingerprint: Sha256Schema }).refine(belongs, "File belongs to another observation/source/listing/variant");
export type OcrInput = z.infer<typeof OcrInputSchema>;

/** Stable domain-separated semantic material. Hashing is injected by the runtime. */
export function ocrFingerprintMaterial(raw: Omit<OcrInput, "inputFingerprint">): string {
  // Pick known fields so a full signed input is also accepted without hashing its own digest.
  const { inputFingerprint: _ignored, ...unsigned } = { inputFingerprint: "", ...raw };
  const i = OcrUnsignedSchema.refine(belongs).parse(unsigned), f = i.file;
  return JSON.stringify(["v3:ocr-input:1", i.schemaVersion, i.requestId, i.observationId, i.operationId, i.module,
    i.brandId, i.sourceId, i.listingId, i.variantId, f.schemaVersion, f.artifactId, f.observationId, f.sourceId, f.listingId, f.variantId,
    f.kind, f.mediaType, f.sha256, f.byteSize, f.producer.operationId, f.producer.module, f.producer.implementationVersion,
    f.kind === "pdf-page" ? f.parentArtifactId : null, f.kind === "pdf-page" ? f.pageIndex : null,
    i.implementationVersion, i.policyVersion, i.resultSchemaVersion, i.configFingerprint]);
}
export function fingerprintOcrInput(input: Omit<OcrInput, "inputFingerprint">, sha256: (material: string) => string): string {
  return Sha256Schema.parse(sha256(ocrFingerprintMaterial(input)));
}
export function parseOcrInput(raw: unknown, sha256: (material: string) => string): OcrInput {
  const input = OcrInputSchema.parse(raw);
  if (fingerprintOcrInput(input, sha256) !== input.inputFingerprint) throw Error("INPUT.FINGERPRINT_MISMATCH");
  return input;
}
export const ProcessingCompatibilitySchema = z.strictObject({ module: z.literal("ocr.file"), ...versions });
export type ProcessingCompatibility = z.infer<typeof ProcessingCompatibilitySchema>;
export function assertOcrCompatibility(input: OcrInput, supported: ProcessingCompatibility): void {
  const expected = ProcessingCompatibilitySchema.parse(supported);
  for (const field of ["module", "schemaVersion", "implementationVersion", "policyVersion", "resultSchemaVersion", "configFingerprint"] as const)
    if (input[field] !== expected[field]) throw Error(`RUNTIME.INCOMPATIBLE_CONSUMER:${field}`);
}

/** Parsed provider evidence: preserve order, whitespace and additional JSON fields. */
export const OcrResponseSchema = z.object({
  text: z.string().max(2000000),
  lines: z.array(z.object({ text: z.string().max(2000000), score: z.number().min(0).max(1),
    polygon: z.array(z.tuple([z.number(), z.number()])).length(4).optional(),
  }).catchall(z.json())).max(20000),
}).catchall(z.json());
export type OcrResponse = z.infer<typeof OcrResponseSchema>;
const outputFields = { ...identity, ...versions, inputFingerprint: Sha256Schema,
  text: z.string().min(1).max(2000000), provider: VersionTagSchema };
export const OcrOutputSchema = z.discriminatedUnion("resultSchemaVersion", [
  z.strictObject({ ...outputFields, resultSchemaVersion: z.literal(1) }),
  z.strictObject({ ...outputFields, resultSchemaVersion: z.literal(2), rawResponse: OcrResponseSchema }),
]).refine(output => output.resultSchemaVersion === 1 || output.text === output.rawResponse.text,
  "OCR text must exactly match retained provider evidence");
export const CompletionSchema = z.strictObject({ ...OperationIdentitySchema.shape,
  resultKey: ObjectKeySchema, resultSha256: Sha256Schema,
  resultByteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), complete: z.literal(true) });
export type OcrOutput = z.infer<typeof OcrOutputSchema>;
export type Completion = z.infer<typeof CompletionSchema>;

export function processingIdentity(input: OcrInput) {
  return { schemaVersion: input.schemaVersion, requestId: input.requestId, observationId: input.observationId,
    operationId: input.operationId, module: input.module, inputFingerprint: input.inputFingerprint,
    implementationVersion: input.implementationVersion, policyVersion: input.policyVersion,
    resultSchemaVersion: input.resultSchemaVersion, configFingerprint: input.configFingerprint };
}
export function observationIdentity(input: z.infer<typeof ObservationSchema>) {
  return {schemaVersion:input.schemaVersion,requestId:input.requestId,observationId:input.observationId,
    brandId:input.brandId,sourceId:input.sourceId,listingId:input.listingId,variantId:input.variantId};
}
export function assertProcessingResultMatches(input: OcrInput, raw: unknown, kind: "output" | "completion"): void {
  const result = kind === "output" ? OcrOutputSchema.parse(raw) : CompletionSchema.parse(raw);
  const expected = processingIdentity(input);
  for (const field of Object.keys(expected) as (keyof typeof expected)[])
    if (result[field] !== expected[field]) throw Error("INPUT.CONFLICT");
}

export const ErrorCategorySchema = z.enum(["SOURCE", "RUNTIME", "ARTIFACT", "PROCESSING", "VALIDATION", "IDENTITY", "INGEST", "SCHEDULER", "UNCLASSIFIED"]);
export const ReviewCodeSchema = z.string().regex(/^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/).max(120);
export const ReviewSchema = z.strictObject({
  schemaVersion: z.literal(1), requestId: ExecutionIdSchema, observationId: ExecutionIdSchema, operationId: ExecutionIdSchema,
  inputFingerprint: Sha256Schema, stage: VersionTagSchema, category: ErrorCategorySchema, code: ReviewCodeSchema,
  executionFact: z.enum(["not_executed", "executed", "unknown"]), evidenceKey: ObjectKeySchema,
  blockedBy: ExecutionIdSchema.nullable(), automaticRetry: z.literal(false),
}).refine(error => !error.blockedBy || (error.executionFact === "not_executed" && error.blockedBy !== error.operationId), "Blocked downstream operation must be unexecuted and refer to another operation");
export type Review = z.infer<typeof ReviewSchema>;
export type ReviewCode = z.infer<typeof ReviewCodeSchema>;
export const VerificationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("verified"), completion: CompletionSchema }),
  z.strictObject({ status: z.literal("unverified"), code: ReviewCodeSchema }),
]);
export type Verification = z.infer<typeof VerificationSchema>;

// A declared, explicit reuse relation, NOT permission to skip evidence checking.
// The registration layer must verify current source evidence + previous bytes.
export const OcrReuseRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), policy: z.literal("explicit-file-reuse/1"),
  target: OcrInputSchema,
  reusedFrom: z.strictObject({ input: OcrInputSchema, completion: CompletionSchema }),
}).refine(record => {
  const a = record.target, b = record.reusedFrom.input;
  if (a.requestId === b.requestId || a.observationId === b.observationId || a.operationId === b.operationId || a.file.artifactId === b.file.artifactId) return false;
  try { assertProcessingResultMatches(b, record.reusedFrom.completion, "completion"); } catch { return false; }
  return a.schemaVersion === b.schemaVersion && a.implementationVersion === b.implementationVersion &&
    a.policyVersion === b.policyVersion && a.resultSchemaVersion === b.resultSchemaVersion && a.configFingerprint === b.configFingerprint &&
    a.file.sha256 === b.file.sha256 && a.file.byteSize === b.file.byteSize && a.file.kind === b.file.kind && a.file.mediaType === b.file.mediaType;
}, "Reuse requires a new observation with identical content/processing versions and matching prior completion");
export type OcrReuseRecord = z.infer<typeof OcrReuseRecordSchema>;
