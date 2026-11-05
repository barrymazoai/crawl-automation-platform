import type { CrossMarketKey, CrossMarketRecord, CrossMarketRecords } from "@crawl-automation/app";
import { AMAZON_CHANNELS, CrossMarketFieldSchema } from "@crawl-automation/v3-contracts";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";

const Row = z.object({
  status: z.enum(["pending", "unjudged", "decided"]),
  reason: z.string().nullable(),
  field: z.unknown(),
  recorded_at: z.string(),
});

/** The cross-market checks (database/v3/072): append-only, the newest per key in force. */
export class PostgresCrossMarketRecords implements CrossMarketRecords {
  constructor(private readonly database: Queryable) {}

  async latest(key: CrossMarketKey): Promise<CrossMarketRecord | null> {
    const rows = await this.database.query(
      `SELECT status, reason, field, recorded_at::text AS recorded_at FROM cross_market_check
        WHERE channel = $1 AND listing_id = $2 AND collection_operation_id = $3 AND compared_listing_id = $4
        ORDER BY check_id DESC LIMIT 1`,
      [key.channel, key.listingId, key.collectionOperationId, key.comparedListingId],
    );
    if (!rows[0]) {
      return null;
    }
    const row = Row.parse(rows[0]);
    const recordedAt = new Date(row.recorded_at).toISOString();
    if (row.status === "decided") {
      return {
        ...key,
        status: "decided",
        field: CrossMarketFieldSchema.parse(row.field),
        recordedAt,
      };
    }
    return row.status === "unjudged"
      ? { ...key, status: "unjudged", reason: z.string().parse(row.reason), recordedAt }
      : { ...key, status: "pending", recordedAt };
  }

  async record(record: CrossMarketRecord): Promise<void> {
    z.enum(AMAZON_CHANNELS as [string, ...string[]]).parse(record.channel);
    await this.database.query(
      `INSERT INTO cross_market_check
         (channel, listing_id, collection_operation_id, compared_listing_id, status, reason, field, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        record.channel,
        record.listingId,
        record.collectionOperationId,
        record.comparedListingId,
        record.status,
        record.status === "unjudged" ? record.reason : null,
        record.status === "decided" ? JSON.stringify(record.field) : null,
        record.recordedAt,
      ],
    );
  }
}
