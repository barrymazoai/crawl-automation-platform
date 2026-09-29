import { appErrors, type BrandRun } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { CollectionSnapshot } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { oncePerRequest } from "./request-receipt.js";

const SourceRow = z.object({
  enabled: z.boolean(),
  revision: z.number(),
  brandId: z.string(),
  brandName: z.string(),
  sourceId: z.string(),
  channel: z.string(),
  region: z.string(),
  url: z.string(),
});

const Accepted = z.object({ requestId: z.string() });

/**
 * Accepts a brand run in the caller's transaction and returns the run ID (its request ID). Repeating the same
 * request returns the earlier run. The operation name matches the earlier API, so its receipts stay valid.
 */
export async function acceptBrandRun(tx: Queryable, run: BrandRun): Promise<string> {
  const key = {
    requestId: run.requestId,
    operation: `collection.submit:${run.brandId}:${run.sourceId}`,
    input: { sourceRevision: run.sourceRevision ?? null },
    parse: (stored: unknown) => Accepted.parse(stored),
  };
  const accepted = await oncePerRequest(tx, key, async () => {
    const snapshot = await lockedSnapshot(tx, run);
    await insertSubmission(tx, run.requestId, snapshot);
    return { requestId: run.requestId };
  });
  return accepted.requestId;
}

/** Freezes the source and brand name; locking the source serialises edits with this run. */
async function lockedSnapshot(tx: Queryable, run: BrandRun): Promise<CollectionSnapshot> {
  const rows = await tx.query(
    `SELECT s.enabled, s.revision, b.id AS "brandId", b.name AS "brandName", s.id AS "sourceId",
       s.channel, s.region, s.url
     FROM brand_source s JOIN brand b ON b.id = s.brand_id
     WHERE s.id = $1 AND s.brand_id = $2 FOR UPDATE OF s FOR SHARE OF b`,
    [run.sourceId, run.brandId],
  );
  if (!rows[0]) {
    throw appErrors.create("RUN.SOURCE_NOT_FOUND", { details: { sourceId: run.sourceId } });
  }
  const source = SourceRow.parse(rows[0]);
  if (!source.enabled) {
    throw appErrors.create("RUN.SOURCE_DISABLED", { details: { sourceId: run.sourceId } });
  }
  if (run.sourceRevision !== undefined && run.sourceRevision !== source.revision) {
    throw appErrors.create("RUN.REVISION_CONFLICT", { details: { current: source.revision } });
  }
  const { enabled: _enabled, revision, ...fields } = source;
  return CollectionSnapshot.parse({ ...fields, sourceRevision: revision });
}

/** Browser channels allow one active run per source; Amazon runs are request-based and may overlap. */
async function insertSubmission(tx: Queryable, requestId: string, snapshot: CollectionSnapshot) {
  if (snapshot.channel !== "amazon") {
    const active = await tx.query("SELECT 1 FROM source_submission_guard WHERE source_id = $1", [
      snapshot.sourceId,
    ]);
    if (active.length > 0) {
      throw appErrors.create("RUN.SOURCE_BUSY", { details: { sourceId: snapshot.sourceId } });
    }
  }
  await tx.query(
    `INSERT INTO collection_submission (request_id, source_id, workflow_id, snapshot)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [requestId, snapshot.sourceId, `v3-collection-${requestId}`, JSON.stringify(snapshot)],
  );
  await tx.query("INSERT INTO source_submission_guard (source_id, request_id) VALUES ($1, $2)", [
    snapshot.sourceId,
    requestId,
  ]);
}
