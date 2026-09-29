import {
  ListingEvidenceSchema,
  ListingStateSchema,
  UnlistedReasonSchema,
  type ListingCounts,
  type ListingCountsQuery,
  type ListingObservation,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

export const COLUMNS = `o.observation_id AS "observationId", o.channel, o.listing_id AS "listingId",
  o.variant_id AS "variantId", o.brand_id AS "brandId", o.run_id AS "runId", o.state, o.reason, o.evidence, o.source,
  o.captured_at AS "capturedAt", o.registered_at AS "registeredAt", d.delivered_at AS "deliveredAt"`;

export interface ObservationRow {
  observationId: string;
  channel: ListingObservation["channel"];
  listingId: string;
  variantId: string | null;
  brandId: string | null;
  runId: string | null;
  state: string;
  reason: string | null;
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
    reason: UnlistedReasonSchema.nullable().parse(row.reason),
    evidence: ListingEvidenceSchema.parse(row.evidence),
    capturedAt: row.capturedAt.toISOString(),
    registeredAt: row.registeredAt.toISOString(),
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
  };
}

/**
 * Sightings per state and per unlisted reason for a channel (and optionally one brand), and how many are not yet
 * sent.
 */
export async function listingCounts(
  database: Queryable,
  query: ListingCountsQuery,
): Promise<ListingCounts> {
  const rows = await database.query<{
    state: string;
    reason: string | null;
    total: number;
    undelivered: number;
  }>(
    `SELECT o.state, o.reason, count(*)::int AS total,
       count(*) FILTER (WHERE d.observation_id IS NULL)::int AS undelivered
     FROM listing_state_observation o LEFT JOIN listing_state_delivery d USING (observation_id)
     WHERE o.channel = $1 AND ($2::uuid IS NULL OR o.brand_id = $2) GROUP BY o.state, o.reason`,
    [query.channel, query.brandId ?? null],
  );
  const counts: ListingCounts = {
    channel: query.channel,
    byState: { unlisted: 0, live: 0 },
    byReason: {
      not_found: 0,
      redirected_to_other_product: 0,
      redirected_away: 0,
      identity_conflict: 0,
    },
    undelivered: 0,
  };
  for (const row of rows) {
    counts.byState[ListingStateSchema.parse(row.state)] += row.total;
    if (row.reason) {
      counts.byReason[UnlistedReasonSchema.parse(row.reason)] = row.total;
    }
    counts.undelivered += row.undelivered;
  }
  return counts;
}
