import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { ResourceGate } from "@crawl-automation/v3-contracts";
import { resourceGate } from "../resources/resource-gate.js";

/** Manually started on a unique test queue; never exported in the production workflow bundle. */
export async function DtcScopeAcceptanceWorkflow(input: {
  resources: ResourceGate;
  evidence: unknown;
}) {
  return resourceGate(input.resources)("reviewScope", (binding) =>
    proxyActivities<{ reviewScope(input: unknown): Promise<unknown> }>({
      taskQueue: workflowInfo().taskQueue,
      startToCloseTimeout: "10 minutes",
      retry: { maximumAttempts: 1 },
      ...binding,
    }).reviewScope(input.evidence),
  );
}
