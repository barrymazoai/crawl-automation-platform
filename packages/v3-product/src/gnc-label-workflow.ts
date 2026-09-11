import { proxyActivities, ApplicationFailure } from "@temporalio/workflow";
import { GncPreparedLabelWorkflowInputSchema, GncLabelOutcomeSchema, imageActivityOptions } from "@crawl-automation/v3-contracts";
import { LabelProductWorkflow } from "./label-workflow.js";
/** Explicit entry for an already prepared GNC source plan, not a live Brand crawler. */
export async function GncPreparedLabelWorkflow(raw: unknown) {
  const decoded = GncPreparedLabelWorkflowInputSchema.safeParse(raw);
  if (!decoded.success) throw ApplicationFailure.nonRetryable("Invalid prepared GNC label input", "GNC.LABEL_INVALID_INPUT");
  const { input, queues } = decoded.data;
  const preparation = proxyActivities<{ prepareGncLabel(input: unknown): Promise<unknown> }>(imageActivityOptions(queues.prepare));
  const parsed = GncLabelOutcomeSchema.safeParse(await preparation.prepareGncLabel(input));
  if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid label preparation receipt", "GNC.LABEL_INVALID_RECEIPT");
  const result = parsed.data;
  if (result.status === "review") {
    if (result.operationId !== input.operationId) throw ApplicationFailure.nonRetryable("Foreign label Review", "GNC.LABEL_IDENTITY_CONFLICT");
    return result;
  }
  if (JSON.stringify(result.input) !== JSON.stringify(input) || result.manifest.operationId !== input.operationId ||
    JSON.stringify(result.manifest.observation) !== JSON.stringify(input.sourcePlan.task.owner) || result.evidenceKey !== `v3/gnc-label-inputs/${input.operationId}/manifest.json`)
    throw ApplicationFailure.nonRetryable("Foreign label preparation", "GNC.LABEL_IDENTITY_CONFLICT");
  const { prepare: _prepare, ...processing } = queues;
  return LabelProductWorkflow({ manifest: result.manifest, queues: processing });
}
