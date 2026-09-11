import { proxyActivities } from "@temporalio/workflow";
import { textActivityOptions, type TextInput, type TextActivityOutcome } from "@crawl-automation/v3-contracts";
export async function BusinessTextProbe(input: { task: TextInput; queue: string }) {
  const activities = proxyActivities<{ interpretText(input: TextInput): Promise<TextActivityOutcome> }>(textActivityOptions(input.queue));
  return activities.interpretText(input.task);
}
