import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type { QueuedProduct } from "../queue/queue-model.js";
import type { QueueService } from "../queue/queue-service.js";
import type { ListRun, ListRunSummary } from "./run-model.js";

export interface ListRunDeps {
  registry: ChannelRegistry;
  queue: Pick<QueueService, "add">;
}

/**
 * A list run: every page goes into the channel's shared queue as one list, identified by the run's request ID; the
 * queue dispatcher starts each page as a product run. Each URL is read by its channel's adapter first, so a page of
 * another site is refused before anything is queued.
 */
export class ListRuns {
  constructor(private readonly deps: ListRunDeps) {}

  async submit(run: ListRun): Promise<ListRunSummary> {
    const adapter = this.deps.registry.get(run.channel);
    const products = run.products.map((product): QueuedProduct => {
      const address = adapter.productAddress(product.url);
      return {
        sourceId: product.sourceId,
        url: address.url,
        listingId: address.listingId,
        variantId: address.variantId,
      };
    });
    const { added } = await this.deps.queue.add({
      channel: run.channel,
      batchId: run.requestId,
      label: run.label,
      products,
    });
    return { kind: "list", runId: run.requestId, channel: run.channel, label: run.label, added };
  }
}
