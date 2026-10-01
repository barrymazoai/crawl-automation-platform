import {
  condition,
  defineSignal,
  setHandler,
  startChild,
  type ChildWorkflowHandle,
} from "@temporalio/workflow";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import type { LabelWorkflowInput } from "../../label/label-model.js";
import { LabelWorkflow } from "../../label/label-workflow.js";
export { LabelWorkflow };

/** Only the parent download boundary is simulated; the child runs the real LabelWorkflow. */
export async function LabelFallbackParent(at: {
  childId: string;
  entry: LabelWorkflowInput;
  file: ArtifactRef;
}) {
  const state: { child?: ChildWorkflowHandle<typeof LabelWorkflow> } = {};
  setHandler(
    defineSignal<[{ operationId: string; sourceId: string }]>("labelSourceRequested"),
    async (request) => {
      await condition(() => !!state.child);
      await state.child?.signal("labelSourceReady", { ...request, file: at.file });
    },
  );
  setHandler(defineSignal<[{ operationId: string }]>("labelSourcesFinished"), async (request) => {
    await condition(() => !!state.child);
    await state.child?.signal("labelStreamSealed", { ...request, status: "closed" });
  });
  state.child = await startChild(LabelWorkflow, { workflowId: at.childId, args: [at.entry] });
  return state.child.result();
}
