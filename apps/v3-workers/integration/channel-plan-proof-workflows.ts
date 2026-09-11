import { proxyActivities } from "@temporalio/workflow";
// Bounded verification workflow; does not submit any downstream model or collection activity.
export async function ChannelPlanProof(input: unknown, taskQueue: string) {
  return proxyActivities<{ prepareChannelProduct(input: unknown): Promise<unknown> }>({ taskQueue,
    startToCloseTimeout: "90 seconds", scheduleToCloseTimeout: "2 minutes", heartbeatTimeout: "15 seconds",
    retry: { maximumAttempts: 1 } }).prepareChannelProduct(input);
}
