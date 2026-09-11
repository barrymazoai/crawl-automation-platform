import { z } from "zod";
import { CreateSource, Id } from "./brands.js";

// Caller selects an existing source revision, never a queue, worker or arbitrary workflow.
export const SubmitCollection = z.strictObject({
  sourceRevision: z.number().int().positive().max(2147483646),
});
export type SubmitCollection = z.infer<typeof SubmitCollection>;

export const CollectionSnapshot = CreateSource.extend({
  brandId: Id,
  brandName: z.string().min(1).max(80),
  sourceId: Id,
  sourceRevision: z.number().int().positive(),
});
export type CollectionSnapshot = z.infer<typeof CollectionSnapshot>;

// This slice records durable intake ONLY, not Workflow execution status.
export const CollectionSubmission = z.strictObject({
  requestId: Id,
  workflowId: z.string().regex(/^v3-collection-[a-f0-9-]{36}$/),
  state: z.literal("PENDING_DELIVERY"),
  snapshot: CollectionSnapshot,
  createdAt: z.iso.datetime({ offset: true }),
}).refine(value => value.workflowId === `v3-collection-${value.requestId}`, {
  message: "Workflow identity must match the submission request", path: ["workflowId"],
});
export type CollectionSubmission = z.infer<typeof CollectionSubmission>;
export const ActiveSubmission = z.strictObject({
  item: CollectionSubmission.nullable(),
});
