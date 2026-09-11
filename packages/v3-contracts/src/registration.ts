import { z } from "zod";
import { ArtifactRefSchema, VersionTagSchema, assertArtifactBelongsTo } from "./artifacts.js";
import { OcrInputSchema, observationIdentity } from "./processing.js";

// The first supported result codec is OCR. New codecs need their own validation;
// arbitrary provider JSON is not treated as a verified processing result.
export const OcrRegistrationSchema = z.strictObject({
  schemaVersion: z.literal(1), storageId: VersionTagSchema,
  input: OcrInputSchema, result: ArtifactRefSchema, completion: ArtifactRefSchema,
}).superRefine((record, ctx) => {
  for (const ref of [record.result, record.completion]) {
    try { assertArtifactBelongsTo(ref, observationIdentity(record.input)); }
    catch { ctx.addIssue({code:"custom",message:"Result ownership mismatch"}); }
    if (ref.kind !== "result-json" || ref.producer.operationId !== record.input.operationId ||
      ref.producer.module !== record.input.module || ref.producer.implementationVersion !== record.input.implementationVersion)
      ctx.addIssue({code:"custom",message:"Result producer mismatch"});
  }
  if (new Set([record.input.file.objectKey,record.result.objectKey,record.completion.objectKey]).size !== 3 ||
      new Set([record.input.file.artifactId,record.result.artifactId,record.completion.artifactId]).size !== 3)
    ctx.addIssue({code:"custom",message:"Artifacts must be distinct"});
});
export type OcrRegistration = z.infer<typeof OcrRegistrationSchema>;
