import { proxyActivities, isCancellation, ApplicationFailure, defineQuery, setHandler } from "@temporalio/workflow";
import { z } from "zod";
import { MixedProductWorkflowInputSchema, ProductImageOutcomeSchema, ProductWorkflowOutcomeSchema, ExecutionIdSchema,
  imageActivityOptions, type ProductEvidenceJoin, type MixedCollectionInput, type VisionTask, type ProductWorkflowOutcome } from "@crawl-automation/v3-contracts";
import { PreparedTextWorkflow } from "./text-workflow.js";
export const mixedProductProgress = defineQuery<{ expected: number; finished: number }>("mixedProductProgress");
/** Closed, already prepared sources. Source processing is concurrent; join/collection are distinct Activities. */
export async function MixedProductWorkflow(raw: unknown): Promise<ProductWorkflowOutcome> {
  const parsed = MixedProductWorkflowInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid mixed product plan", "MIXED.INVALID_INPUT");
  const { manifest, queues } = parsed.data;
  let finished = 0; setHandler(mixedProductProgress, () => ({ expected: manifest.sources.length, finished }));
  const vision = proxyActivities<{ interpretImage(task: VisionTask): Promise<unknown> }>(imageActivityOptions(queues.vision));
  const review = z.object({ status: z.literal("review"), reviewId: ExecutionIdSchema });
  const states = await Promise.all(manifest.sources.map(async (source): Promise<ProductEvidenceJoin["states"][number]> => {
    try {
      if (source.kind === "text") {
        const result = await PreparedTextWorkflow({ task: source.task, queues: { text: queues.text, receipts: queues.textReceipts } });
        return result.status === "registered" ? { id: source.id, status: "registered" } : { id: source.id, status: "review", reviewId: result.reviewId };
      }
      const outcome = await vision.interpretImage(source.task), failed = review.safeParse(outcome);
      if (failed.success) return { id: source.id, status: "review", reviewId: failed.data.reviewId };
      const registered = z.object({ status: z.literal("registered"), operationId: z.literal(source.task.input.operationId) }).safeParse(outcome);
      return { id: source.id, status: registered.success ? "registered" : "rejected" };
    } catch (error) {
      if (isCancellation(error)) throw error;
      // Explicit protocol-invalid text receipts must not turn into success by recovery.
      if (error instanceof ApplicationFailure && ["TEXT_RECEIPT.INVALID_RECEIPT", "TEXT_RECEIPT.IDENTITY_CONFLICT"].includes(error.type ?? ""))
        return { id: source.id, status: "rejected" };
      return { id: source.id, status: "unresolved" }; // Assembly only rechecks durable evidence, never executes upstream.
    } finally { finished++; }
  }));
  return finishMixedProduct({ manifest, states }, queues);
}
export async function finishMixedProduct(join: ProductEvidenceJoin, queues: { assembly: string; collection: string }): Promise<ProductWorkflowOutcome> {
  const { manifest } = join;
  const assembly = proxyActivities<{ assembleProductEvidence(join: ProductEvidenceJoin): Promise<unknown> }>(imageActivityOptions(queues.assembly));
  const collection = proxyActivities<{ collectMixedProduct(input: MixedCollectionInput): Promise<unknown> }>(imageActivityOptions(queues.collection));
  const decoded = ProductImageOutcomeSchema.safeParse(await assembly.assembleProductEvidence(join));
  if (!decoded.success) throw ApplicationFailure.nonRetryable("Invalid mixed assembly receipt", "MIXED.RECEIPT_INVALID");
  const assembled = decoded.data;
  if (assembled.status === "review") return assembled;
  if (assembled.evidenceKey !== `v3/product-evidence/${manifest.operationId}/assembly.json`)
    throw ApplicationFailure.nonRetryable("Mixed assembly identity mismatch", "MIXED.IDENTITY_CONFLICT");
  const saved = ProductWorkflowOutcomeSchema.safeParse(await collection.collectMixedProduct({ join, evidenceKey: assembled.evidenceKey }));
  if (!saved.success) throw ApplicationFailure.nonRetryable("Invalid mixed collection receipt", "MIXED.RECEIPT_INVALID");
  if (saved.data.evidenceKey !== assembled.evidenceKey || (saved.data.status === "collected" &&
    (saved.data.operationId !== manifest.operationId || saved.data.observationId !== manifest.observation.observationId)))
    throw ApplicationFailure.nonRetryable("Mixed collection identity mismatch", "MIXED.IDENTITY_CONFLICT");
  return saved.data;
}
