import type { HistoryAnswer, HistoryQuery, ProductHistoryReader } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { z } from "zod";

const ListingRow = z.object({
  historyListingId: z.string(),
  site: z.string().nullable(),
  externalId: z.string().nullable(),
  basis: z.string(),
});

const PointRow = z.object({
  observationId: z.string(),
  historyListingId: z.string(),
  observedAt: z.date().nullable(),
  record: z.record(z.string(), z.unknown()),
});

/** The history tables (018), read only: a listing by its channel and product ID, and its points newest first. */
export class PostgresHistoryReader implements ProductHistoryReader {
  constructor(private readonly database: Database) {}

  async find(query: HistoryQuery): Promise<HistoryAnswer> {
    const listings = (
      await this.database.query(
        `SELECT listing_id AS "historyListingId", site, external_id AS "externalId", identity_basis AS basis
         FROM product_history_listing WHERE channel = $1 AND external_id = $2 ORDER BY listing_id`,
        [query.channel, query.externalId],
      )
    ).map((row) => ListingRow.parse(row));
    if (listings.length === 0) {
      return { listings, points: [] };
    }
    const rows = await this.database.query(
      `SELECT observation_id AS "observationId", listing_id AS "historyListingId", observed_at AS "observedAt",
         record
       FROM product_history_observation WHERE listing_id = ANY($1::text[]) AND kind = $2
       ORDER BY observed_at DESC NULLS LAST, observation_id LIMIT $3`,
      [listings.map((listing) => listing.historyListingId), query.kind, query.limit],
    );
    const points = rows.map((row) => {
      const point = PointRow.parse(row);
      return { ...point, observedAt: point.observedAt?.toISOString() ?? null };
    });
    return { listings, points };
  }
}
