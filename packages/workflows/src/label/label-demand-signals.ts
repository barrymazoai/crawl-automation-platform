import { defineSignal, getExternalWorkflowHandle, workflowInfo } from "@temporalio/workflow";
import { identityConflict } from "./identity-conflict.js";
import type { LabelTask } from "./label-model.js";

export const labelSourceRequested = defineSignal<[unknown]>("labelSourceRequested");
export const labelSourcesFinished = defineSignal<[unknown]>("labelSourcesFinished");

/** The label child alone admits downloads, and seals only after all admitted work has settled. */
export function demandSignals(task: LabelTask) {
  const parent = workflowInfo().parent;
  if (!parent) {
    throw identityConflict();
  }
  const handle = getExternalWorkflowHandle(parent.workflowId, parent.runId);
  const requested = new Set<string>();
  let finished = false;
  return {
    async request(sourceId: string) {
      if (requested.has(sourceId)) {
        return;
      }
      requested.add(sourceId);
      await handle.signal(labelSourceRequested, { operationId: task.operationId, sourceId });
    },
    async finish() {
      if (finished) {
        return;
      }
      finished = true;
      await handle.signal(labelSourcesFinished, { operationId: task.operationId });
    },
  };
}
