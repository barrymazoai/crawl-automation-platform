import { CancellationScope, proxyActivities } from "@temporalio/workflow";
import { versionedResourceGate } from "../versioned-gate.js";

export { ProductPipelineWorkflow, LabelWorkflow } from "../../workflows.js";

export interface GateScenario {
  queue: string;
  mode: "complete" | "review" | "failure" | "cancel" | "timeout" | "scope-timeout";
}

/** Only simulated work: no providers, browser pages or external processes are started by these tests. */
export async function GateScenarioWorkflow(input: GateScenario) {
  const gate = versionedResourceGate({
    queue: input.queue,
    activities: { work: [{ resourceId: "test-resource", units: 1 }] },
    maxWaitSeconds: 10,
  });
  const execute = () =>
    gate("work", (binding) => {
      const activities = proxyActivities<{ work(mode: GateScenario["mode"]): Promise<unknown> }>({
        taskQueue: input.queue,
        startToCloseTimeout: input.mode === "timeout" ? "1 second" : "1 minute",
        retry: { maximumAttempts: 1 },
        ...binding,
        heartbeatTimeout: "1 second",
      });
      return activities.work(input.mode);
    });
  return input.mode === "scope-timeout"
    ? CancellationScope.withTimeout("1 second", execute)
    : execute();
}
