import { createHash } from "node:crypto";
import { appErrors, type BrandRun } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { CollectionSnapshot } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { storeErrors } from "../errors.js";

const Receipt = z.object({ operation: z.string(), fingerprint: z.string(), result: z.unknown() });
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

/** The receipt names the operation the same way the earlier API did, so its replays stay compatible. */
function receiptOf(run: BrandRun) {
  const operation = `collection.submit:${run.brandId}:${run.sourceId}`;
  const input = JSON.stringify({ sourceRevision: run.sourceRevision ?? null });
  return { operation, fingerprint: createHash("sha256").update(input).digest("hex") };
}

/**
 * Accepts a brand run in the caller's transaction. Returns the request ID, which is also the run ID.
 * A repeated request ID with the same input returns the earlier run; different input is refused.
 */
export async function acceptBrandRun(tx: Queryable, run: BrandRun): Promise<string> {
  await tx.query("SET LOCAL lock_timeout = '3s'");
  const { operation, fingerprint } = receiptOf(run);
  const inserted = await tx.query(
    `INSERT INTO api_request_receipt (request_id, operation, fingerprint) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING request_id`,
    [run.requestId, operation, fingerprint],
  );
  if (inserted.length === 0) {
    return replayedRun(tx, run.requestId, { operation, fingerprint });
  }
  const snapshot = await lockedSnapshot(tx, run);
  await insertSubmission(tx, run.requestId, snapshot);
  await tx.query("UPDATE api_request_receipt SET result = $2::jsonb WHERE request_id = $1", [
    run.requestId,
    JSON.stringify({ requestId: run.requestId, snapshot }),
  ]);
  return run.requestId;
}

async function replayedRun(
  tx: Queryable,
  requestId: string,
  expected: { operation: string; fingerprint: string },
): Promise<string> {
  const rows = await tx.query(
    "SELECT operation, fingerprint, result FROM api_request_receipt WHERE request_id = $1 FOR UPDATE",
    [requestId],
  );
  const receipt = Receipt.parse(rows[0]);
  if (receipt.operation !== expected.operation || receipt.fingerprint !== expected.fingerprint) {
    throw appErrors.create("RUN.REQUEST_ID_CONFLICT", { details: { requestId } });
  }
  if (receipt.result == null) {
    throw storeErrors.create("STORE.RECEIPT_INCOMPLETE", { details: { requestId } });
  }
  return requestId;
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
