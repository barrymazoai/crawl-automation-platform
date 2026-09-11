import { proxyActivities, isCancellation, ApplicationFailure } from "@temporalio/workflow";
import { LabelProductWorkflowInputSchema, LabelProductJoinSchema, ProductImageOutcomeSchema, ProductWorkflowOutcomeSchema, ExecutionIdSchema,
  imageActivityOptions, type LabelProductJoin } from "@crawl-automation/v3-contracts";
import { PreparedTextWorkflow } from "./text-workflow.js";
/** Explicit new protocol/queue; old histories and saved-source paths are not reinterpreted. */
export async function LabelProductWorkflow(raw: unknown) {
  const parsed = LabelProductWorkflowInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid label manifest", "LABEL_PRODUCT.INVALID_INPUT");
  const { manifest, queues } = parsed.data;
  const vision = proxyActivities<{ interpretImage(input: unknown): Promise<unknown> }>(imageActivityOptions(queues.vision));
  const states = await Promise.all(manifest.sources.map(async (source): Promise<LabelProductJoin["states"][number]> => {
    try {
      if (source.kind === "text") {
        const result = await PreparedTextWorkflow({ task: source.task, queues: { text: queues.text, receipts: queues.textReceipts } });
        return result.status === "registered" ? { id: source.id, status: "registered" } : { id: source.id, status: "review", reviewId: result.reviewId };
      }
      const result = await vision.interpretImage(source.task) as { status?: string; operationId?: string; reviewId?: string } | null;
      if (result?.status === "review" && ExecutionIdSchema.safeParse(result.reviewId).success) return { id: source.id, status: "review", reviewId: result.reviewId! };
      return { id: source.id, status: result?.status === "registered" && result.operationId === source.task.input.operationId ? "registered" : "rejected" };
    } catch (error) {
      if (isCancellation(error)) throw error;
      if (error instanceof ApplicationFailure && ["TEXT_RECEIPT.INVALID_RECEIPT", "TEXT_RECEIPT.IDENTITY_CONFLICT"].includes(error.type ?? "")) return { id: source.id, status: "rejected" };
      return { id: source.id, status: "unresolved" };
    }
  }));
  return finishLabelProduct({ manifest, states }, queues);
}
export async function finishLabelProduct(raw: LabelProductJoin, queues: { assembly: string; collection: string }) {
  const join = LabelProductJoinSchema.parse(raw), { manifest } = join;
  const assembly = proxyActivities<{ assembleLabelProduct(input: unknown): Promise<unknown> }>(imageActivityOptions(queues.assembly));
  const collection = proxyActivities<{ collectLabelProduct(input: unknown): Promise<unknown> }>(imageActivityOptions(queues.collection));
  const out = ProductImageOutcomeSchema.safeParse(await assembly.assembleLabelProduct(join));
  if (!out.success) throw ApplicationFailure.nonRetryable("Invalid label receipt", "LABEL_PRODUCT.RECEIPT_INVALID");
  const key = `v3/label-products/${manifest.operationId}/assembly.json`;
  if (out.data.evidenceKey !== key) throw ApplicationFailure.nonRetryable("Wrong label receipt", "LABEL_PRODUCT.IDENTITY_CONFLICT");
  if (out.data.status === "review") return out.data;
  const saved = ProductWorkflowOutcomeSchema.safeParse(await collection.collectLabelProduct({ join, evidenceKey: key }));
  if (!saved.success || saved.data.evidenceKey !== key || saved.data.status === "collected" &&
    (saved.data.operationId !== manifest.operationId || saved.data.observationId !== manifest.observation.observationId))
    throw ApplicationFailure.nonRetryable("Invalid label collection", "LABEL_PRODUCT.IDENTITY_CONFLICT");
  return saved.data;
}
