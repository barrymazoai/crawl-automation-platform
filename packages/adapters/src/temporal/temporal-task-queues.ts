import type { FleetTaskQueues, TaskQueueKind, TaskQueuePoller } from "@crawl-automation/app";
import type { Client } from "@temporalio/client";
import { optionalTsToDate } from "@temporalio/common/lib/time.js";
import { temporal } from "@temporalio/proto";

const { TaskQueueType, TaskQueueKind: QueueKind } = temporal.api.enums.v1;

/** Poller identities include workers on other machines sharing the client's namespace. */
export class TemporalTaskQueues implements FleetTaskQueues {
  constructor(private readonly client: Client) {}

  async describe(name: string, kind: TaskQueueKind): Promise<TaskQueuePoller[]> {
    const response = await this.client.connection.withDeadline(Date.now() + 5_000, () =>
      this.client.workflowService.describeTaskQueue({
        namespace: this.client.options.namespace,
        taskQueue: { name, kind: QueueKind.TASK_QUEUE_KIND_NORMAL },
        taskQueueType:
          kind === "workflow"
            ? TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW
            : TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
      }),
    );
    return (response.pollers ?? []).map((poller) => ({
      identity: poller.identity ?? "",
      lastAccessTime: optionalTsToDate(poller.lastAccessTime)?.toISOString() ?? null,
      ratePerSecond: poller.ratePerSecond ?? null,
    }));
  }
}
