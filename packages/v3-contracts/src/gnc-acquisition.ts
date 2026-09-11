import { z } from "zod";
import { ArtifactRefSchema, ObservationSchema, ExecutionIdSchema, ObjectKeySchema, Sha256Schema } from "./artifacts.js";
import { NetworkRouteSchema } from "./network.js";
import { GncCaptureInputSchema, GncCatalogPageSchema, GncProductEvidenceSchema } from "./gnc.js";
export const GncAcquireInputSchema = z.strictObject({ schemaVersion: z.literal(1), implementationVersion: z.literal("gnc-acquire/1"),
  owner: ObservationSchema, capture: GncCaptureInputSchema, network: NetworkRouteSchema,
}).refine(i => i.owner.requestId === i.capture.requestId && i.owner.brandId === i.capture.brandId && i.owner.sourceId === i.capture.sourceId &&
  i.network.egressId === i.capture.binding.egressId && (i.capture.kind !== "catalog-page" || i.owner.variantId === null), "Capture ownership/route mismatch");
export type GncAcquireInput = z.infer<typeof GncAcquireInputSchema>;
export const GncExecutionIntentSchema = z.strictObject({ input: GncAcquireInputSchema, nonce: z.uuid() });
const received = { schemaVersion: z.literal(1), input: GncAcquireInputSchema, nonce: z.uuid(), receivedAt: z.iso.datetime(),
  source: ArtifactRefSchema.refine(a => a.kind === "source-html") };
export const GncReceivedRecordSchema = z.strictObject({ ...received, codec: z.literal("gnc-received/1") });
export const GncAcquiredRecordSchema = z.strictObject({ ...received, codec: z.literal("gnc-acquired/1"),
  evidence: ArtifactRefSchema.refine(a => a.kind === "result-json") });
export type GncReceivedRecord = z.infer<typeof GncReceivedRecordSchema>;
export type GncAcquiredRecord = z.infer<typeof GncAcquiredRecordSchema>;
export const GncParsedEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("product"), data: GncProductEvidenceSchema, network: NetworkRouteSchema }),
  z.strictObject({ kind: z.literal("catalog-page"), data: GncCatalogPageSchema, network: NetworkRouteSchema }),
]);
export const GncAcquireOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("durable"), operationId: ExecutionIdSchema, inputFingerprint: Sha256Schema,
    source: ArtifactRefSchema, evidence: ArtifactRefSchema, evidenceKey: ObjectKeySchema }),
  z.strictObject({ status: z.literal("review"), operationId: ExecutionIdSchema, reviewId: ExecutionIdSchema, evidenceKey: ObjectKeySchema,
    code: z.string(), automaticRetry: z.literal(false) }),
]);
export type GncAcquireOutcome = z.infer<typeof GncAcquireOutcomeSchema>;
export const GncReceiptInputSchema = z.strictObject({ task: GncAcquireInputSchema, receipt: GncAcquireOutcomeSchema.nullable() });
export const GNC_QUEUES = Object.freeze({ catalog: "v3.gnc.catalog.v1.gnc-v1", product: "v3.gnc.product.v1.gnc-v1",
  receipt: "v3.gnc.receipt.v1.gnc-v1", workflow: "v3.gnc.workflow.v1.gnc-workflow-v1" });
export const GncWorkflowInputSchema = z.strictObject({ task: GncAcquireInputSchema });
