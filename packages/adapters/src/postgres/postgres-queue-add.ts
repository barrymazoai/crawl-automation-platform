import { createHash } from "node:crypto";
import { appErrors, type AddToQueue, type ScanAdmissionSettings } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresScanAdmission } from "./postgres-scan-admission.js";

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Called inside the channel queue transaction/lock, including admission and its durable receipt. */
export class PostgresQueueAdd {
  constructor(private readonly tx: Queryable) {}

  async add(input: AddToQueue, discovery?: ScanAdmissionSettings) {
    await this.assertSourcesOnChannel(input);
    const admission = new PostgresScanAdmission(this.tx);
    if (!(await this.insertBatch(input))) {
      return discovery ? admission.replay(input.batchId) : { added: 0 };
    }
    const rows = JSON.stringify(queueRows(input));
    if (discovery) {
      return admission.insert({ input, rows, settings: discovery });
    }
    const inserted = await this.tx.query<{ state: string }>(
      `INSERT INTO queue_item (item_id, channel, batch_id, source_id, url, listing_id, variant_id)
       SELECT r.item_id, $1, $2, r.source_id, r.url, r.listing_id, r.variant_id
       FROM jsonb_to_recordset($3::jsonb)
         AS r(item_id text, source_id uuid, url text, listing_id text, variant_id text)
       ON CONFLICT DO NOTHING RETURNING item_id, state`,
      [input.channel, input.batchId, rows],
    );
    const following = inserted.filter((item) => item.state === "following").length;
    return {
      added: inserted.filter((item) => item.state === "queued").length,
      ...(following ? { following } : {}),
    };
  }

  private async assertSourcesOnChannel(input: AddToQueue): Promise<void> {
    const sourceIds = [...new Set(input.products.map((product) => product.sourceId))];
    const rows = await this.tx.query<{ found: number }>(
      "SELECT count(*)::int AS found FROM brand_source WHERE id = ANY($1::uuid[]) AND channel = $2",
      [sourceIds, input.channel],
    );
    if (rows[0]?.found !== sourceIds.length) {
      throw appErrors.create("QUEUE.SOURCE_CHANNEL_MISMATCH", {
        details: { channel: input.channel },
      });
    }
  }

  /** Keep the pre-window hash unchanged, including for an interrupted historical scan. */
  private async insertBatch(input: AddToQueue): Promise<boolean> {
    const hash = sha256(input);
    const inserted = await this.tx.query(
      `INSERT INTO link_batch (batch_id, channel, label, item_count, record_hash) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING RETURNING batch_id`,
      [input.batchId, input.channel, input.label, input.products.length, hash],
    );
    if (inserted.length === 1) {
      return true;
    }
    const saved = await this.tx.query<{ record_hash: string }>(
      "SELECT record_hash FROM link_batch WHERE batch_id = $1",
      [input.batchId],
    );
    if (saved[0]?.record_hash !== hash) {
      throw appErrors.create("QUEUE.IMPORT_CONFLICT", { details: { batchId: input.batchId } });
    }
    return false;
  }
}

function queueRows(input: AddToQueue) {
  // Repeated cards or URLs for one SKU count once. Preserve the first observation, as before.
  const seen = new Set<string>();
  return input.products
    .map((product) => ({
      item_id: sha256([input.channel, input.batchId, product.listingId, product.variantId]),
      source_id: product.sourceId,
      url: product.url,
      listing_id: product.listingId,
      variant_id: product.variantId,
    }))
    .filter((row) => {
      if (seen.has(row.item_id)) {
        return false;
      }
      seen.add(row.item_id);
      return true;
    });
}
