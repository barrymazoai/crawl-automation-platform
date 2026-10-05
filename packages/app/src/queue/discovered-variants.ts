import { createHash } from "node:crypto";
import type { AddToQueue, QueuedProduct } from "./queue-model.js";
import type { QueueAddResult } from "./scan-admission.js";

export interface DiscoveredVariantStore {
  /** The products this channel's queue has never held, in any state. */
  unseen(channel: string, products: QueuedProduct[]): Promise<QueuedProduct[]>;
  add(list: AddToQueue): Promise<QueueAddResult>;
}

const LABEL = "Variants named on a captured product page";

/** One list per run (UUID-shaped), so a replayed activity adds nothing twice. */
function runBatchId(runId: string, channel: string): string {
  const hex = createHash("sha256").update(`discovered-variants:${channel}:${runId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Variants a captured page names (Whole Foods variation ASINs, Costco child items) join the channel's queue under the
 * run's brand source. Only variants the channel has never queued are added, so siblings that name each other cannot
 * requeue one another forever; a known variant is revisited by its own brand scans.
 */
export class DiscoveredVariants {
  constructor(private readonly store: DiscoveredVariantStore) {}

  async queue(input: {
    runId: string;
    channel: AddToQueue["channel"];
    sourceId: string;
    variants: { url: string; listingId: string; variantId: string | null }[];
  }): Promise<{ added: number; known: number }> {
    const products = input.variants.map((variant) => ({ ...variant, sourceId: input.sourceId }));
    const unseen = await this.store.unseen(input.channel, products);
    if (!unseen.length) {
      return { added: 0, known: products.length };
    }
    const { added } = await this.store.add({
      channel: input.channel,
      batchId: runBatchId(input.runId, input.channel),
      label: LABEL,
      products: unseen,
    });
    return { added, known: products.length - unseen.length };
  }
}
