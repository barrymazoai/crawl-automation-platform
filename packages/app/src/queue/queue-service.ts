import type { Logger } from "@crawl-automation/platform";
import type {
  AddToQueue,
  PauseQueue,
  QueueItemsQuery,
  QueueItemView,
  QueueLimits,
  QueueStatus,
  QueueStore,
  Requeue,
} from "./queue-model.js";

/**
 * The product queue: add products, pause and resume intake, set how many run at once, and queue finished
 * products again. The queue runner process picks the work up; nothing here starts a workflow directly.
 */
export class QueueService {
  constructor(private readonly deps: { queue: QueueStore; log: Logger }) {}

  status(): Promise<QueueStatus> {
    return this.deps.queue.status();
  }

  items(query: QueueItemsQuery): Promise<QueueItemView[]> {
    return this.deps.queue.items(query);
  }

  async add(input: AddToQueue): Promise<{ added: number }> {
    const result = await this.deps.queue.add(input);
    this.deps.log.info({ campaignId: input.campaignId, ...result }, "products queued");
    return result;
  }

  async setLimits(limits: QueueLimits): Promise<QueueStatus> {
    await this.deps.queue.setLimits(limits);
    this.deps.log.info(limits, "queue limits set");
    return this.deps.queue.status();
  }

  async pause(options: PauseQueue): Promise<QueueStatus> {
    await this.deps.queue.pause(options);
    this.deps.log.info(options, options.force ? "queue stopping" : "queue draining");
    return this.deps.queue.status();
  }

  async resume(): Promise<QueueStatus> {
    await this.deps.queue.resume();
    this.deps.log.info("queue resumed");
    return this.deps.queue.status();
  }

  async requeue(input: Requeue): Promise<{ requeued: number }> {
    const result = await this.deps.queue.requeue(input);
    this.deps.log.info(result, "products queued again");
    return result;
  }
}
