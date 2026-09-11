import { z } from "zod";
import { CatalogScopeSchema } from "./catalog.js";
import { ExecutionIdSchema, VersionTagSchema } from "./artifacts.js";
import { NetworkRouteSchema } from "./network.js";
import { GncProductInputSchema } from "./gnc-product.js";
import { GncLabelInputSchema, GncStreamingLabelWorkflowInputSchema } from "./gnc-label.js";

/** Deployment policy, never a previous product input with identity fields replaced. */
export const GncCatalogProductPolicySchema = z.strictObject({
  codec: z.literal("gnc-catalog-product-policy/1"),
  catalogId: ExecutionIdSchema,
  scope: CatalogScopeSchema.refine(s => s.channel === "gnc"),
  network: NetworkRouteSchema,
  sourceText: GncProductInputSchema.shape.text,
  ocr: GncProductInputSchema.shape.ocr,
  sourceVisionConfigFingerprint: GncProductInputSchema.shape.visionConfigFingerprint,
  text: GncLabelInputSchema.shape.text,
  visionConfigFingerprint: GncLabelInputSchema.shape.visionConfigFingerprint,
  corePolicy: GncLabelInputSchema.shape.corePolicy,
  evidencePolicy: GncLabelInputSchema.shape.evidencePolicy,
  queues: GncStreamingLabelWorkflowInputSchema.shape.queues,
  resources: GncStreamingLabelWorkflowInputSchema.shape.resources,
  browserPhase: z.boolean().optional(),
  queue: VersionTagSchema,
}).refine(p => Boolean(p.corePolicy) === Boolean(p.queues.core), "Core policy and queue must match")
  .refine(p => Boolean(p.queues.capture && p.queues.captureReceipts && p.queues.productPlan), "Capture queues required");
export type GncCatalogProductPolicy = z.infer<typeof GncCatalogProductPolicySchema>;
export const CatalogProductBindingSchema = z.strictObject({
  input: GncStreamingLabelWorkflowInputSchema, queue: VersionTagSchema, browserPhase:z.boolean().optional(),
});
export type CatalogProductBinding = z.infer<typeof CatalogProductBindingSchema>;
