import { proxyActivities } from "@temporalio/workflow";
import { resourceGate } from "../../../packages/v3-product/src/resource-workflow.js";
export async function ResourceRecoveryFixture(input: unknown, queue: string) {
  const gate = resourceGate({ queue, activities: { ocrFile: [{ resourceId: "test-cpu", units: 1 }] } });
  const activities = proxyActivities<{ ocrFile(x: unknown): Promise<unknown> }>({ taskQueue: queue, startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } });
  return gate("ocrFile", () => activities.ocrFile(input));
}
