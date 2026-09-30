import { recordWorkflowRecovery } from "../workflow-recovery.js";
import { CollectionWorkflowInput } from "@crawl-automation/v3-contracts";
import { proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import { failureCode } from "../failure-code.js";
import {
  CollectionScanSchema,
  SCAN_MISSING,
  MAX_READ_FAILURES,
  SCAN_POLL,
  type CollectionActivities,
  type CollectionResult,
  type CollectionScan,
} from "./collection-model.js";

const scans = () =>
  proxyActivities<CollectionActivities>({
    taskQueue: workflowInfo().taskQueue,
    startToCloseTimeout: "1 minute",
    // A read of the scan table: nothing is paid, and the loop below decides what a failed read means.
    retry: { maximumAttempts: 1 },
  });

/**
 * A brand run: the API requested the brand's scan when it accepted the run; the scan (brand-scan runner) puts every
 * listed product into the shared queue, and each product then runs as its own ProductPipelineWorkflow. This
 * workflow holds the run open until the scan has finished, so the run's source guard blocks a second run of the
 * same brand source meanwhile. It starts no children and pays for nothing itself.
 */
export async function CollectionWorkflow(raw: unknown): Promise<CollectionResult> {
  const input = CollectionWorkflowInput.parse(raw);
  const request = { requestId: input.requestId, sourceId: input.snapshot.sourceId };
  const scan = await finishedScan(request);
  return {
    codec: "collection-settled/1",
    requestId: input.requestId,
    scanId: scan.scanId,
    state: scan.state as CollectionResult["state"],
    queued: scan.queued ?? 0,
    code: scan.code,
  };
}

async function finishedScan(request: {
  requestId: string;
  sourceId: string;
}): Promise<CollectionScan> {
  const activities = scans();
  let failures = 0;
  for (;;) {
    try {
      const scan = CollectionScanSchema.parse(await activities.brandScanOf(request));
      failures = 0;
      if (scan.state !== "queued" && scan.state !== "running") {
        return scan;
      }
    } catch (error) {
      recordWorkflowRecovery(error, { operation: "collection.inspect" });
      failures += 1;
      // A run whose scan was never requested cannot finish by waiting.
      if (failureCode(error) === SCAN_MISSING || failures >= MAX_READ_FAILURES) {
        throw error;
      }
    }
    await sleep(SCAN_POLL);
  }
}
