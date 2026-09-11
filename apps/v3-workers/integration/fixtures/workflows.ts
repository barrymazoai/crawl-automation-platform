import { proxyActivities } from "@temporalio/workflow";

// Synthetic protocol only; never exported by the business registry.
export async function RuntimeIsolationProbe(input: { requestId: string; queue: string; delayMs: number; fail?: boolean }) {
  if (!/^v3\.test\.[a-z0-9-]+\.fixture\.echo\.v1\.c1$/.test(input.queue)) throw new Error("Test queue only");
  const activities = proxyActivities<{ echo(input: { requestId: string; delayMs: number; fail: boolean }): Promise<{ requestId: string; pid: number; hostId: string }> }>({
    taskQueue: input.queue, startToCloseTimeout: "30 seconds", scheduleToCloseTimeout: "60 seconds", retry: { maximumAttempts: 1 },
  });
  return activities.echo({ requestId: input.requestId, delayMs: input.delayMs, fail: input.fail ?? false });
}
