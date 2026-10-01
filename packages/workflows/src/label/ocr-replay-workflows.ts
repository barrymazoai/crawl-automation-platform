import {
  condition,
  defineSignal,
  setHandler,
  startChild,
  type ChildWorkflowHandle,
} from "@temporalio/workflow";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import type { LabelWorkflowInput } from "./label-model.js";
import { LabelWorkflow } from "./label-workflow.js";
export { LabelWorkflow };

/** Replay harness supplies only requested files; all child decisions use the real LabelWorkflow. */
export async function OcrFailureParent(at: {
  childId: string;
  entry: LabelWorkflowInput;
  files: Record<string, ArtifactRef | undefined>;
}) {
  const state: { child?: ChildWorkflowHandle<typeof LabelWorkflow> } = {};
  setHandler(
    defineSignal<[{ operationId: string; sourceId: string }]>("labelSourceRequested"),
    async (request) => {
      await condition(() => !!state.child);
      await state.child?.signal("labelSourceReady", {
        ...request,
        file: at.files[request.sourceId],
      });
    },
  );
  setHandler(defineSignal<[{ operationId: string }]>("labelSourcesFinished"), async (request) => {
    await condition(() => !!state.child);
    await state.child?.signal("labelStreamSealed", { ...request, status: "closed" });
  });
  state.child = await startChild(LabelWorkflow, { workflowId: at.childId, args: [at.entry] });
  return state.child.result();
}
