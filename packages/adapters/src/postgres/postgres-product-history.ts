import {
  canonical,
  historyErrors,
  type HistoryEntry,
  type ProductHistoryStore,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";

interface SourceRow {
  body_hash: string;
  record: unknown;
}

interface ObservationRow {
  observation_id: string;
  listing_id: string;
  kind: string;
  observed_at: Date | null;
  record: unknown;
}

/**
 * The append-only history tables (product_history_source, _listing, _listing_source, _observation,
 * _observation_source), written as the earlier history store wrote them: one transaction per entry, the same entry
 * again adds nothing, a different body under the same source ID is a conflict, and every row is read back.
 */
export class PostgresProductHistory implements ProductHistoryStore {
  constructor(private readonly database: Database) {}

  append(entry: HistoryEntry): Promise<{ inserted: boolean }> {
    return this.database.transaction(async (tx) => {
      const prior = await readSource(tx, entry.id);
      if (prior) {
        assertSameSource(prior, entry);
        return { inserted: false };
      }
      await insertSource(tx, entry);
      await insertListings(tx, entry);
      await insertObservations(tx, entry);
      await verify(tx, entry);
      return { inserted: true };
    });
  }
}

async function readSource(tx: Queryable, id: string): Promise<SourceRow | null> {
  const rows = await tx.query<SourceRow>(
    "SELECT body_hash, record FROM product_history_source WHERE source_record_id = $1",
    [id],
  );
  return rows[0] ?? null;
}

function assertSameSource(row: SourceRow, entry: HistoryEntry): void {
  if (row.body_hash !== entry.bodyHash || canonical(row.record) !== canonical(entry.raw)) {
    throw historyErrors.create("HISTORY.CONTENT_CONFLICT", { details: { sourceId: entry.id } });
  }
}

async function insertSource(tx: Queryable, entry: HistoryEntry): Promise<void> {
  await tx.query(
    `INSERT INTO product_history_source (source_record_id, dataset, source_key, body_hash, record, issues)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) ON CONFLICT DO NOTHING`,
    [
      entry.id,
      entry.dataset,
      entry.sourceKey,
      entry.bodyHash,
      JSON.stringify(entry.raw),
      JSON.stringify(entry.issues),
    ],
  );
}

async function insertListings(tx: Queryable, entry: HistoryEntry): Promise<void> {
  for (const listing of entry.listings) {
    await tx.query(
      `INSERT INTO product_history_listing (listing_id, channel, site, external_id, identity_basis, identity)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT DO NOTHING`,
      [
        listing.id,
        listing.channel,
        listing.site,
        listing.externalId,
        listing.basis,
        JSON.stringify(listing.identity),
      ],
    );
    await tx.query(
      "INSERT INTO product_history_listing_source VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [listing.id, entry.id, listing.url],
    );
  }
}

async function insertObservations(tx: Queryable, entry: HistoryEntry): Promise<void> {
  for (const point of entry.observations) {
    await tx.query(
      `INSERT INTO product_history_observation (observation_id, listing_id, kind, observed_at, record)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
      [point.id, point.listingId, point.kind, point.observedAt, JSON.stringify(point.record)],
    );
    await tx.query(
      "INSERT INTO product_history_observation_source VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [point.id, entry.id],
    );
  }
}

/** The source row and every observation read back exactly as written. */
async function verify(tx: Queryable, entry: HistoryEntry): Promise<void> {
  const saved = await readSource(tx, entry.id);
  const sameSource =
    saved?.body_hash === entry.bodyHash && canonical(saved.record) === canonical(entry.raw);
  const rows = await tx.query<ObservationRow>(
    `SELECT observation_id, listing_id, kind, observed_at, record FROM product_history_observation
     WHERE observation_id = ANY($1::text[])`,
    [entry.observations.map((point) => point.id)],
  );
  const byId = new Map(rows.map((row) => [row.observation_id, row]));
  const samePoints = entry.observations.every((point) =>
    sameObservation(byId.get(point.id), point),
  );
  if (!sameSource || !samePoints) {
    throw historyErrors.create("HISTORY.READBACK_MISMATCH", { details: { sourceId: entry.id } });
  }
}

function sameObservation(
  row: ObservationRow | undefined,
  point: HistoryEntry["observations"][number],
): boolean {
  return (
    !!row &&
    row.listing_id === point.listingId &&
    row.kind === point.kind &&
    (row.observed_at?.toISOString() ?? null) === point.observedAt &&
    canonical(row.record) === canonical(point.record)
  );
}
