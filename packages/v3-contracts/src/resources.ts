import { z } from "zod";
import { ExecutionIdSchema, VersionTagSchema } from "./artifacts.js";
export const ResourceNeedSchema = z.strictObject({ resourceId: ExecutionIdSchema, units: z.number().int().min(1).max(64) });
// A pool is interchangeable capacity (owner 2026-10-06: three Ego spaces for DTC products); the grant takes one free member.
const PoolSchema = z.array(ExecutionIdSchema).min(2).max(8);
export const ResourceRequestSchema = z.strictObject({ permitId: ExecutionIdSchema, workflowId: ExecutionIdSchema,
  runId: z.uuid(), needs: z.array(ResourceNeedSchema).min(1).max(8), pool: PoolSchema.optional() })
  .refine(r => new Set([...r.needs.map(n => n.resourceId), ...(r.pool ?? [])]).size === r.needs.length + (r.pool?.length ?? 0));
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;
export const ResourceDecisionSchema = z.strictObject({ permitId: ExecutionIdSchema, status: z.enum(["granted", "waiting", "released"]),
  reason: z.union([z.enum(["available", "capacity", "unhealthy", "released"]), z.string().regex(/^browser:BROWSER\.[A-Z_]+$/).max(200)]),
  // The pool member a granted pooled request holds.
  host: ExecutionIdSchema.optional() });
export const ResourceGateSchema = z.strictObject({ queue: VersionTagSchema,
  // Allow OCR's 120 s independent cleanup to finish and publish its journal receipt.
  stopVerificationSeconds: z.number().int().min(1).max(600).optional(),
  stopVerificationPollSeconds: z.number().int().min(1).max(30).optional(),
  reviewStopCheck: z.boolean().optional(),
  // The gated work is one synchronous provider request (no browser, no owned process): a Review receipt from the
  // Activity already means nothing is running outside it, so the permit is released without a stop proof.
  releaseOnReview: z.boolean().optional(),
  activities: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/), z.array(ResourceNeedSchema).min(1).max(8)),
  pools: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/), PoolSchema).optional(),
  maxWaitSeconds: z.number().int().min(10).max(3600).default(900),
});
export type ResourceGate = z.infer<typeof ResourceGateSchema>;
