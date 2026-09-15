import { z } from "zod";
import { ArtifactRefSchema, ExecutionIdSchema, VersionTagSchema, ObjectKeySchema } from "./artifacts.js";
import { OcrInputSchema, ReviewCodeSchema } from "./processing.js";

export const OcrIntentSchema = z.strictObject({ schemaVersion: z.literal(1), input: OcrInputSchema,
  nonce: z.uuid(), nodeId: ExecutionIdSchema, storageId: VersionTagSchema, createdAt: z.iso.datetime() });
export type OcrIntent = z.infer<typeof OcrIntentSchema>;
export const OcrActivityOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("registered"), operationId: ExecutionIdSchema,
    result: ArtifactRefSchema, completion: ArtifactRefSchema, resultRegistered: z.literal(true) }),
  // Cloud mode: evidence is durable in object storage; the Mini receipt step registers it in the ledger.
  z.strictObject({ status: z.literal("uploaded"), operationId: ExecutionIdSchema,
    result: ArtifactRefSchema, completion: ArtifactRefSchema, resultRegistered: z.literal(false) }),
  z.strictObject({ status: z.literal("review"), operationId: ExecutionIdSchema,
    reviewId: ExecutionIdSchema, code: ReviewCodeSchema, evidenceKey: ObjectKeySchema, automaticRetry: z.literal(false) }),
]);
export type OcrActivityOutcome = z.infer<typeof OcrActivityOutcomeSchema>;
/** Workflow-safe policy. Activity-side guard additionally rejects attempts > 1. */
export function ocrActivityOptions(taskQueue: string) {
  return { taskQueue, startToCloseTimeout: "2 minutes" as const, scheduleToCloseTimeout: "10 minutes" as const,
    heartbeatTimeout: "10 seconds" as const, retry: { maximumAttempts: 1 } };
}
