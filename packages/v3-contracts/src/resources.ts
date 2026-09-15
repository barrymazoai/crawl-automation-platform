import { z } from "zod";
import { ExecutionIdSchema, VersionTagSchema } from "./artifacts.js";
export const ResourceNeedSchema = z.strictObject({ resourceId: ExecutionIdSchema, units: z.number().int().min(1).max(64) });
export const ResourceRequestSchema = z.strictObject({ permitId: ExecutionIdSchema, workflowId: ExecutionIdSchema,
  runId: z.uuid(), needs: z.array(ResourceNeedSchema).min(1).max(8) }).refine(r => new Set(r.needs.map(n => n.resourceId)).size === r.needs.length);
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;
export const ResourceDecisionSchema = z.strictObject({ permitId: ExecutionIdSchema, status: z.enum(["granted", "waiting", "released"]),
  reason: z.enum(["available", "capacity", "unhealthy", "released"]) });
export const ResourceGateSchema = z.strictObject({ queue: VersionTagSchema,
  reviewStopCheck: z.boolean().optional(),
  // The gated work is one synchronous provider request (no browser, no owned process): a Review receipt from the
  // Activity already means nothing is running outside it, so the permit is released without a stop proof.
  releaseOnReview: z.boolean().optional(),
  activities: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/), z.array(ResourceNeedSchema).min(1).max(8)),
  maxWaitSeconds: z.number().int().min(10).max(3600).default(900),
});
export type ResourceGate = z.infer<typeof ResourceGateSchema>;
