import { proxyActivities } from "@temporalio/workflow";
import { ocrActivityOptions, type OcrInput, type OcrActivityOutcome } from "@crawl-automation/v3-contracts";

// Test-only orchestrator, used exclusively against a newly created local Temporal server.
export async function BusinessOcrProbe(input: { task: OcrInput; queue: string }) {
  const activities = proxyActivities<{ ocrFile(input: OcrInput): Promise<OcrActivityOutcome> }>(ocrActivityOptions(input.queue));
  return activities.ocrFile(input.task);
}
