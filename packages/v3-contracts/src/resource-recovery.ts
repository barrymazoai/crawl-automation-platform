import { z } from "zod";
import { ResourceRequestSchema } from "./resources.js";
import { Sha256Schema, ExecutionIdSchema } from "./artifacts.js";

export const ResourceRecoveryProofSchema = z.strictObject({
  codec: z.literal("resource-release-proof/1"), namespace: z.string().min(1).max(255), request: ResourceRequestSchema,
  historySha256: Sha256Schema, workflowBundleSha256: Sha256Schema,
  grantEventId: z.number().int().positive(), releaseIntentEventId: z.number().int().positive(), terminalEventId: z.number().int().positive(),
  verifiedEffects: z.array(z.strictObject({ activityId: z.string().min(1), activityType: z.string().min(1),
    scheduledEventId: z.number().int().positive(), completedEventId: z.number().int().positive() })).min(1),
}).refine(p => p.grantEventId < p.releaseIntentEventId && p.releaseIntentEventId < p.terminalEventId &&
  p.verifiedEffects.every(e => e.scheduledEventId > p.grantEventId && e.completedEventId > e.scheduledEventId && e.completedEventId < p.releaseIntentEventId));
export type ResourceRecoveryProof = z.infer<typeof ResourceRecoveryProofSchema>;
export const ResourceRecoveryResultSchema = z.strictObject({ permitId: ExecutionIdSchema,
  status: z.enum(["already_released", "recoverable", "released", "quarantined"]),
  code: z.string().regex(/^RESOURCE_RECOVERY\.[A-Z_]+$/), evidenceKey: z.string().optional() });
