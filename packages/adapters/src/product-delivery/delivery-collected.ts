import type { Queryable } from "@crawl-automation/platform";
import {
  DELIVERY_COLLECTIONS,
  DELIVERY_EARLIER_COLLECTION,
  DELIVERY_LIVE_REVISIT,
} from "./delivery-queries.js";

export interface DeliveryQueueRow {
  item_id: string;
  batch_id: string;
  source_id: string;
  listing_id: string;
  variant_id: string | null;
  state: string;
  run_id: string | null;
  settled_at: Date | null;
  outcome: string | null;
}

export interface CollectedQueue {
  queue: DeliveryQueueRow;
  rows: { operation_id: string }[];
}

/**
 * Which attempt's collected products a completed SKU is delivered from.
 *
 * KAN-259: the newest completed attempt normally owns the SKU's material. A metrics-only revisit of a live listing
 * collects nothing, so its SKU is read from the newest other completed attempt that collected it. A newer Review,
 * pending or unlisted attempt still never falls back to an older success, and a Review attempt is never used.
 */
export class DeliveryCollections {
  constructor(private readonly database: Queryable) {}

  async of(queue: DeliveryQueueRow, scanIds: string[] | null): Promise<CollectedQueue> {
    const rows = await this.collections(queue);
    if (rows.length || !(await this.liveRevisit(queue))) {
      return { queue, rows };
    }
    const [earlier] = await this.database.query<DeliveryQueueRow>(DELIVERY_EARLIER_COLLECTION, [
      queue.source_id,
      queue.listing_id,
      queue.variant_id,
      queue.run_id,
      scanIds,
    ]);
    return earlier ? { queue: earlier, rows: await this.collections(earlier) } : { queue, rows };
  }

  private collections(queue: DeliveryQueueRow) {
    return this.database.query<{ operation_id: string }>(DELIVERY_COLLECTIONS, [
      queue.run_id,
      queue.source_id,
    ]);
  }

  private async liveRevisit(queue: DeliveryQueueRow) {
    if (!queue.run_id) {
      return false;
    }
    const [sightings] = await this.database.query<{ live: number; other: number }>(
      DELIVERY_LIVE_REVISIT,
      [queue.listing_id, queue.run_id],
    );
    return !!sightings && sightings.live > 0 && sightings.other === 0;
  }
}
