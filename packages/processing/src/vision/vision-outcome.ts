import { z } from "zod";
import {
  ArtifactRefSchema,
  ObjectKeySchema,
  VisionTaskSchema,
} from "@crawl-automation/v3-contracts";

/** What the vision step reports: a stored result (registered, or uploaded in cloud mode), or a Review. */
export const VisionOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.enum(["registered", "uploaded"]),
    operationId: z.string(),
    candidateStatus: z.enum(["candidate", "partial"]),
    result: ArtifactRefSchema,
    completion: ArtifactRefSchema,
    evidenceKey: ObjectKeySchema,
  }),
  z.strictObject({
    status: z.literal("review"),
    operationId: z.string(),
    reviewId: z.string(),
    code: z.string(),
    evidenceKey: ObjectKeySchema,
    automaticRetry: z.literal(false),
  }),
]);
export type VisionOutcome = z.infer<typeof VisionOutcomeSchema>;

/** What the vision receipt is asked to confirm: the task and what the step reported, if it reported. */
export const VisionReceiptInputSchema = z.strictObject({
  task: VisionTaskSchema,
  outcome: VisionOutcomeSchema.nullable(),
});
