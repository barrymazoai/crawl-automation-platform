import {
  ChannelPlanOutcomeSchema,
  FileAcquireOutcomeSchema,
  type ChannelPlanInput,
  type FileAcquireOutcome,
} from "@crawl-automation/v3-contracts";
import {
  ApplicationFailure,
  CancellationScope,
  ParentClosePolicy,
  WorkflowIdReusePolicy,
  startChild,
  workflowInfo,
  type ChildWorkflowHandle,
} from "@temporalio/workflow";
import type { z } from "zod";
import type { PipelineActivities, ProductPipelineInput } from "./pipeline-model.js";

type Manifest = Extract<
  z.infer<typeof ChannelPlanOutcomeSchema>,
  { status: "prepared" }
>["manifest"];
type LabelChild = ChildWorkflowHandle<(raw: unknown) => Promise<unknown>>;

export interface LabelStep {
  input: ProductPipelineInput;
  pipeline: PipelineActivities;
  sourcePlan: ChannelPlanInput;
  manifest: Manifest;
}

/**
 * Reads the formula with the existing label workflow. The page source is ready at once; each label image is
 * downloaded, then handed to the label workflow as soon as its receipt exists. The stream is sealed on every ending.
 */
export async function streamLabel(step: LabelStep): Promise<unknown> {
  const handoff = await step.pipeline.prepareLabelHandoff({
    pipeline: step.input,
    sourcePlan: step.sourcePlan,
  });
  const labelId = handoff.input.operationId;
  const child: LabelChild = await startChild("ChannelStreamingLabelWorkflow", {
    workflowId: `${workflowInfo().workflowId}-label`,
    taskQueue: step.input.queues.label,
    args: [handoff],
    parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    retry: { maximumAttempts: 1 },
  });
  const seal = (status: "closed" | "failed") =>
    child.signal("channelStreamSealed", { operationId: labelId, status });
  try {
    const review = await feedFiles(step, child, labelId);
    await seal(review ? "failed" : "closed");
    const result = await child.result();
    return review ?? result;
  } catch (error) {
    await CancellationScope.nonCancellable(() => seal("failed").catch(() => undefined));
    throw error;
  }
}

/** Downloads each label image and signals it to the label workflow; a file Review stops the feed. */
async function feedFiles(
  step: LabelStep,
  child: LabelChild,
  labelId: string,
): Promise<FileAcquireOutcome | null> {
  for (const source of step.manifest.sources) {
    if (source.kind !== "file-image") {
      continue;
    }
    const acquire = source.plan.acquire;
    const receipt = FileAcquireOutcomeSchema.parse(
      await step.pipeline.acquireProductFile({
        pipeline: step.input,
        sourcePlan: step.sourcePlan,
        acquire,
      }),
    );
    if (receipt.operationId !== acquire.operationId) {
      throw ApplicationFailure.nonRetryable(
        "File receipt identity conflict",
        "PIPELINE.FILE_IDENTITY",
      );
    }
    if (receipt.status === "review") {
      return receipt;
    }
    await child.signal("channelSourceReady", {
      operationId: labelId,
      sourceId: source.id,
      file: receipt.file,
    });
  }
  return null;
}
