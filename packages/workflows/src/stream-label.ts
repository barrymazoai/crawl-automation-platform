import { recordWorkflowRecovery } from "./workflow-recovery.js";
import { pipelineErrors } from "@crawl-automation/platform/errors/activity";
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
  patched,
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

/** The signals each label workflow understands (the shared one, and the earlier per-channel one). */
interface StreamSignals {
  workflowType: string;
  ready: string;
  sealed: string;
}

const SHARED: StreamSignals = {
  workflowType: "LabelWorkflow",
  ready: "labelSourceReady",
  sealed: "labelStreamSealed",
};
const EARLIER: StreamSignals = {
  workflowType: "ChannelStreamingLabelWorkflow",
  ready: "channelSourceReady",
  sealed: "channelStreamSealed",
};

/**
 * Reads the formula with the Label workflow. The page source is ready at once; each label image is downloaded, then
 * handed to the label workflow as soon as its receipt exists. The stream is sealed on every ending. Histories
 * recorded before the shared Label workflow keep replaying the earlier per-channel one.
 */
export async function streamLabel(step: LabelStep): Promise<unknown> {
  const shared = patched("shared-label-workflow-v1");
  const request = { pipeline: step.input, sourcePlan: step.sourcePlan };
  const handoff = shared
    ? await step.pipeline.prepareLabelTask(request)
    : await step.pipeline.prepareLabelHandoff(request);
  const signals = shared ? SHARED : EARLIER;
  const labelId = handoff.input.operationId;
  const child: LabelChild = await startChild(signals.workflowType, {
    workflowId: `${workflowInfo().workflowId}-label`,
    taskQueue: step.input.queues.label,
    args: [handoff],
    parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    retry: { maximumAttempts: 1 },
  });
  const seal = (status: "closed" | "failed") =>
    child.signal(signals.sealed, { operationId: labelId, status });
  try {
    const review = await feedFiles(step, { child, labelId, signal: signals.ready });
    await seal(review ? "failed" : "closed");
    const result = await child.result();
    return review ?? result;
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      seal("failed").catch((failure: unknown) => {
        recordWorkflowRecovery(failure, { operation: "label.seal", originalError: error });
      }),
    );
    throw error;
  }
}

/** Downloads each label image and signals it to the label workflow; a file Review stops the feed. */
async function feedFiles(
  step: LabelStep,
  target: { child: LabelChild; labelId: string; signal: string },
): Promise<FileAcquireOutcome | null> {
  const { child, labelId } = target;
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
        pipelineErrors.code("PIPELINE.FILE_IDENTITY"),
      );
    }
    if (receipt.status === "review") {
      return receipt;
    }
    await child.signal(target.signal, {
      operationId: labelId,
      sourceId: source.id,
      file: receipt.file,
    });
  }
  return null;
}
