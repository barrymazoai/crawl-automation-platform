import type { ActivityCancellationType } from "@temporalio/workflow";

export interface ResourceActivityBinding {
  activityId: string;
  cancellationType: typeof ActivityCancellationType.WAIT_CANCELLATION_COMPLETED;
  heartbeatTimeout?: "30 seconds";
}

/** What the permit granted beyond its fixed needs: the pool member it holds. */
export interface ResourceGrant {
  host?: string;
}

export type GatedWork<Result> = (
  binding?: ResourceActivityBinding,
  grant?: ResourceGrant,
) => Promise<Result>;
