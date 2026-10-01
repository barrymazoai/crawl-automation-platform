import { z } from "zod";
import { ArtifactRefSchema, Sha256Schema, assertArtifactBelongsTo } from "./artifacts.js";
import { ReviewRecordSchema } from "./reviews.js";
import { VisionInputSchema } from "./vision.js";

/** A verified saved Review answer, not a registered vision success or a fabricated completion. */
export const LabelReviewedImageRecordSchema = z
  .strictObject({
    codec: z.literal("vision-reviewed/1"),
    input: VisionInputSchema,
    configFingerprint: Sha256Schema,
    result: ArtifactRefSchema,
    review: ReviewRecordSchema,
  })
  .superRefine((record, context) => {
    const failure = record.review.failure;
    try {
      assertArtifactBelongsTo(record.result, record.input.selection.observation);
    } catch {
      context.addIssue({ code: "custom", message: "Reviewed image result ownership conflict" });
    }
    if (
      failure.stage !== "codex.vision" ||
      failure.executionFact !== "executed" ||
      failure.operationId !== record.input.operationId ||
      failure.evidenceKey !== record.result.objectKey ||
      record.result.objectKey !== `v3/vision/${record.input.operationId}/response.json` ||
      record.result.producer.operationId !== record.input.operationId ||
      record.result.producer.module !== "codex.vision" ||
      JSON.stringify(record.review.observation) !==
        JSON.stringify(record.input.selection.observation)
    ) {
      context.addIssue({ code: "custom", message: "Reviewed image identity conflict" });
    }
  });
