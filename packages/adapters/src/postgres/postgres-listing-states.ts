import { isDeepStrictEqual } from "node:util";
import {
  appErrors,
  type DeliveredSighting,
  type ListingCounts,
  type ListingCountsQuery,
  type ListingObservation,
  type ListingQuery,
  type ListingStateStore,
  type NewListingObservation,
} from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import {
  COLUMNS,
  listingCounts,
  toObservation,
  type ObservationRow,
} from "./listing-state-queries.js";

/** `listing_state_observation` and its delivery marks: sightings written once, never changed. */
export class PostgresListingStates implements ListingStateStore {
  constructor(private readonly database: Database) {}

  async record(observation: NewListingObservation): Promise<ListingObservation> {
    const values = [
      observation.observationId,
      observation.channel,
      observation.listingId,
      observation.variantId,
      observation.brandId,
      observation.runId,
      observation.state,
      JSON.stringify(observation.evidence),
      observation.source,
      observation.capturedAt,
    ];
    await this.database.query(
      `INSERT INTO listing_state_observation (observation_id, channel, listing_id, variant_id, brand_id, run_id,
         state, evidence, source, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) ON CONFLICT (observation_id) DO NOTHING`,
      values,
    );
    const saved = await this.read(observation.observationId);
    if (!saved || !sameSighting(saved, observation)) {
      throw appErrors.create("LISTING.OBSERVATION_CONFLICT", {
        details: { observationId: observation.observationId },
      });
    }
    return saved;
  }

  async list(query: ListingQuery): Promise<ListingObservation[]> {
    const rows = await this.database.query<ObservationRow>(
      `SELECT ${COLUMNS} FROM listing_state_observation o
       LEFT JOIN listing_state_delivery d USING (observation_id)
       WHERE o.channel = $1 AND ($2::uuid IS NULL OR o.brand_id = $2)
         AND ($3::text IS NULL OR o.listing_id = $3) AND ($4::text IS NULL OR o.state = $4)
       ORDER BY o.captured_at DESC, o.observation_id LIMIT $5`,
      [
        query.channel,
        query.brandId ?? null,
        query.listingId ?? null,
        query.state ?? null,
        query.limit,
      ],
    );
    return rows.map(toObservation);
  }

  counts(query: ListingCountsQuery): Promise<ListingCounts> {
    return listingCounts(this.database, query);
  }

  async undelivered(limit: number): Promise<ListingObservation[]> {
    const rows = await this.database.query<ObservationRow>(
      `SELECT ${COLUMNS} FROM listing_state_observation o
       LEFT JOIN listing_state_delivery d USING (observation_id)
       WHERE d.observation_id IS NULL ORDER BY o.registered_at, o.observation_id LIMIT $1`,
      [limit],
    );
    return rows.map(toObservation);
  }

  async markDelivered(results: DeliveredSighting[]): Promise<void> {
    for (const result of results) {
      await this.database.query(
        `INSERT INTO listing_state_delivery (observation_id, status, response) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (observation_id) DO NOTHING`,
        [result.observationId, result.status, JSON.stringify(result.response ?? null)],
      );
    }
  }

  private async read(observationId: string): Promise<ListingObservation | null> {
    const rows = await this.database.query<ObservationRow>(
      `SELECT ${COLUMNS} FROM listing_state_observation o
       LEFT JOIN listing_state_delivery d USING (observation_id) WHERE o.observation_id = $1`,
      [observationId],
    );
    return rows[0] ? toObservation(rows[0]) : null;
  }
}

/** The same sighting: everything but the time it was recorded (the first record's time is kept). */
function sameSighting(saved: ListingObservation, observation: NewListingObservation): boolean {
  const fields = [
    "channel",
    "listingId",
    "variantId",
    "brandId",
    "runId",
    "state",
    "evidence",
    "source",
  ] as const;
  return fields.every((field) => isDeepStrictEqual(saved[field], observation[field]));
}
