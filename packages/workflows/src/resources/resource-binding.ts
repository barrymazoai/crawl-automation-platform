import type { ActivityCancellationType } from "@temporalio/workflow";

export interface ResourceActivityBinding {
  activityId: string;
  cancellationType: typeof ActivityCancellationType.WAIT_CANCELLATION_COMPLETED;
  heartbeatTimeout?: "30 seconds";
}

export type GatedWork<Result> = (binding?: ResourceActivityBinding) => Promise<Result>;
