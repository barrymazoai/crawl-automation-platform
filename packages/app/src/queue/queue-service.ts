import type { Logger } from "@crawl-automation/platform";
import type {
  AddToQueue,
  PauseQueue,
  QueueChannel,
  QueueItemsQuery,
  QueueItemView,
  QueueLimits,
  QueueStatus,
  QueueStore,
  Requeue,
} from "./queue-model.js";

export interface QueueServiceDeps {
  /** Amazon's existing queue tables (amazon_queue_*), kept as they are. */
  amazon: QueueStore;
  /** The shared queue tables every other channel uses. */
  channels: QueueStore;
  log: Logger;
}

/**
 * The product queue of every channel: add products, pause and resume intake, set how many run at once, and queue
 * finished products again. The queue dispatcher starts the work; nothing here starts a workflow directly.
 */
export class QueueService {
  constructor(private readonly deps: QueueServiceDeps) {}

  status(channel: QueueChannel): Promise<QueueStatus> {
    return this.store(channel).status(channel);
  }

  items(query: QueueItemsQuery): Promise<QueueItemView[]> {
    return this.store(query.channel).items(query);
  }

  async add(input: AddToQueue): Promise<{ added: number }> {
    const result = await this.store(input.channel).add(input);
    const list = input.channel === "amazon" ? input.campaignId : input.batchId;
    this.deps.log.info({ channel: input.channel, list, ...result }, "products queued");
    return result;
  }

  async setLimits(limits: QueueLimits): Promise<QueueStatus> {
    await this.store(limits.channel).setLimits(limits);
    this.deps.log.info(limits, "queue limits set");
    return this.status(limits.channel);
  }

  async pause(options: PauseQueue): Promise<QueueStatus> {
    await this.store(options.channel).pause(options);
    this.deps.log.info(options, options.force ? "queue stopping" : "queue draining");
    return this.status(options.channel);
  }

  async resume(channel: QueueChannel): Promise<QueueStatus> {
    await this.store(channel).resume(channel);
    this.deps.log.info({ channel }, "queue resumed");
    return this.status(channel);
  }

  async requeue(input: Requeue): Promise<{ requeued: number }> {
    const result = await this.store(input.channel).requeue(input);
    this.deps.log.info({ channel: input.channel, ...result }, "products queued again");
    return result;
  }

  private store(channel: QueueChannel): QueueStore {
    return channel === "amazon" ? this.deps.amazon : this.deps.channels;
  }
}
