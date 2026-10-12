import type { ListingObservation, ListingTargets } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/**
 * Which Supply Smart external IDs a delisting covers, from the product sync ledger (migration 061): one per variant row
 * the listing was synced under (`''` meaning the listing itself); a sighting of one variant covers only that variant;
 * a listing never synced is sent under its own ID, so Supply Smart can still match an older listing.
 */
export class PostgresListingTargets implements ListingTargets {
  constructor(private readonly database: Queryable) {}

  async externalIds(sightings: ListingObservation[]): Promise<Map<string, string[]>> {
    const rows = await this.database.query<{
      channel: string;
      listing_id: string;
      variant_key: string;
    }>(
      `SELECT channel, listing_id, variant_key FROM product_sync
       WHERE (channel, listing_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [
        sightings.map((sighting) => sighting.channel),
        sightings.map((sighting) => sighting.listingId),
      ],
    );
    return new Map(
      sightings.map((sighting) => {
        const synced = rows
          .filter(
            (row) => row.channel === sighting.channel && row.listing_id === sighting.listingId,
          )
          .map((row) => row.variant_key || row.listing_id);
        const own = sighting.variantId ?? sighting.listingId;
        return [sighting.observationId, sighting.variantId || synced.length === 0 ? [own] : synced];
      }),
    );
  }
}
