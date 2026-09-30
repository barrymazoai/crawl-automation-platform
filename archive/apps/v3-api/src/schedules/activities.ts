import { ScheduleTick, type ScheduleTickResult } from "@crawl-automation/v3-contracts";

// Composition-root injection: independent intake Activity Worker, no provider
// calls. Binds one cluster/namespace/queue before accepting DB writes.
export function scheduleActivities(submissions: { acceptScheduled(tick: ScheduleTick): Promise<{value: ScheduleTickResult}> },
  scope: { clusterId: string; namespace: string; activityQueue: string }) {
  return { acceptScheduleTick: async (raw: ScheduleTick) => {
    const tick = ScheduleTick.parse(raw);
    if (tick.definition.clusterId !== scope.clusterId || tick.namespace !== scope.namespace ||
        tick.definition.activityQueue !== scope.activityQueue) throw Error("Schedule Activity scope mismatch");
    return (await submissions.acceptScheduled(tick)).value;
  } };
}
