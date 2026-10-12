import type { KnownVariants } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/** Variants a listing offered before: every variant ever queued for it on its channel (`queue_item`). */
export class PostgresKnownVariants implements Pick<KnownVariants, "known"> {
  constructor(private readonly database: Queryable) {}

  async known(channel: string, listingId: string): Promise<string[]> {
    const rows = await this.database.query<{ variant_id: string }>(
      `SELECT DISTINCT variant_id FROM queue_item
       WHERE channel = $1 AND listing_id = $2 AND variant_id IS NOT NULL ORDER BY variant_id`,
      [channel, listingId],
    );
    return rows.map((row) => row.variant_id);
  }
}
