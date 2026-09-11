import { proxyActivities, ApplicationFailure } from "@temporalio/workflow";
import { LabelCoreWorkflowInputSchema, LabelCoreOutcomeSchema, imageActivityOptions } from "@crawl-automation/v3-contracts";
/** Independent preparation workflow, also used to verify deployment without running any provider. */
export async function LabelCoreWorkflow(raw: unknown) {
  const { input, queue } = LabelCoreWorkflowInputSchema.parse(raw);
  const activity = proxyActivities<{ prepareLabelCore(input: unknown): Promise<unknown> }>(imageActivityOptions(queue));
  const result = LabelCoreOutcomeSchema.parse(await activity.prepareLabelCore(input));
  if (JSON.stringify(result.input) !== JSON.stringify(input)) throw ApplicationFailure.nonRetryable("Foreign core receipt", "LABEL_CORE.IDENTITY_CONFLICT");
  return result;
}
