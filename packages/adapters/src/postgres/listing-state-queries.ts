import {
  ListingEvidenceSchema,
  ListingStateSchema,
  type ListingCounts,
  type ListingCountsQuery,
  type ListingObservation,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

export const COLUMNS = `o.observation_id AS "observationId", o.channel, o.listing_id AS "listingId",
  o.variant_id AS "variantId", o.brand_id AS "brandId", o.run_id AS "runId", o.state, o.evidence, o.source,
  o.captured_at AS "capturedAt", o.registered_at AS "registeredAt", d.delivered_at AS "deliveredAt"`;

export interface ObservationRow {
  observationId: string;
  channel: ListingObservation["channel"];
  listingId: string;
  variantId: string | null;
  brandId: string | null;
  runId: string | null;
  state: string;
  evidence: unknown;
  source: string;
  capturedAt: Date;
  registeredAt: Date;
  deliveredAt: Date | null;
}

export function toObservation(row: ObservationRow): ListingObservation {
  return {
    ...row,
    state: ListingStateSchema.parse(row.state),
    evidence: ListingEvidenceSchema.parse(row.evidence),
    capturedAt: row.capturedAt.toISOString(),
    registeredAt: row.registeredAt.toISOString(),
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
  };
}

/** Sightings per state for a channel (and optionally one brand), and how many are not yet sent. */
export async function listingCounts(
  database: Queryable,
  query: ListingCountsQuery,
): Promise<ListingCounts> {
  const rows = await database.query<{ state: string; total: number; undelivered: number }>(
    `SELECT o.state, count(*)::int AS total, count(*) FILTER (WHERE d.observation_id IS NULL)::int AS undelivered
     FROM listing_state_observation o LEFT JOIN listing_state_delivery d USING (observation_id)
     WHERE o.channel = $1 AND ($2::uuid IS NULL OR o.brand_id = $2) GROUP BY o.state`,
    [query.channel, query.brandId ?? null],
  );
  const byState = { gone: 0, superseded: 0, live: 0 };
  let undelivered = 0;
  for (const row of rows) {
    byState[ListingStateSchema.parse(row.state)] = row.total;
    undelivered += row.undelivered;
  }
  return { channel: query.channel, byState, undelivered };
}
