import { canonicalHash, type EnrichmentSource } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { enrichmentErrors } from "@crawl-automation/processing";
import { EnrichmentSubjectSchema, type EnrichmentRequest } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { PostgresCollectedProducts } from "./postgres-collected-products.js";
import { PostgresFormulaIndex } from "./postgres-formula-index.js";

const HistorySchema = z.object({
  listing: z.object({ channel: z.string(), externalId: z.string() }),
  capture: z
    .object({
      variantId: z.string().nullable().optional(),
      projection: z.object({ title: z.string().nullable().optional() }).passthrough().optional(),
      title: z.string().nullable().optional(),
    })
    .passthrough(),
});
type HistoryRow = { source_record_id: string; body_hash: string; record: unknown };

/** The selected product's own title only; a linked formula never supplies a sibling title. */
export async function enrichmentSource(
  database: Queryable,
  request: EnrichmentRequest,
  channels: string[],
): Promise<EnrichmentSource> {
  const collection = await new PostgresCollectedProducts(database).read(
    request.collectionOperationId,
  );
  if (!collection) {
    throw enrichmentErrors.create("ENRICH.INPUT_MISSING");
  }
  const listingId = request.listingId ?? collection.observation.listingId;
  const variantId =
    request.variantId === undefined ? collection.observation.variantId : request.variantId;
  await verifyFormulaOwner(database, { request, listingId, variantId, channels });
  const identity = {
    channel: request.channel,
    listingId,
    variantId,
    collectionOperationId: collection.operationId,
    observation: collection.observation,
  };
  const page =
    (request.captureOperationId || request.sourcePlan
      ? null
      : await earlierPage(database, identity)) ??
    (await historyPage(database, identity, request.captureOperationId ?? null));
  return { collection, subject: EnrichmentSubjectSchema.parse({ ...identity, ...page }) };
}

async function historyPage(
  database: Queryable,
  identity: { channel: string; listingId: string; variantId: string | null },
  captureOperationId: string | null,
) {
  const rows = await database.query<HistoryRow>(
    `
    SELECT source_record_id, body_hash, record FROM product_history_source
     WHERE record->'listing'->>'channel' = $1 AND record->'listing'->>'externalId' = $2
       AND record->'capture'->>'variantId' IS NOT DISTINCT FROM $3
       AND ($4::text IS NULL OR source_key = $4)
       AND record->>'codec' LIKE 'v3-capture-history/%'
     ORDER BY record->>'capturedAt' DESC NULLS LAST, source_record_id DESC LIMIT 1`,
    [identity.channel, identity.listingId, identity.variantId, captureOperationId],
  );
  return {
    title: historyTitle(checkedHistory(rows[0])),
    titleEvidence: rows[0]
      ? { sourceId: rows[0].source_record_id, sha256: rows[0].body_hash }
      : null,
  };
}

async function verifyFormulaOwner(
  database: Queryable,
  target: {
    request: EnrichmentRequest;
    listingId: string;
    variantId: string | null;
    channels: string[];
  },
) {
  const rows = await database.query(
    `
    SELECT 1 FROM collected_product p JOIN brand_source s
      ON s.id::text = p.record->'observation'->>'sourceId'
     WHERE p.operation_id = $1 AND s.channel = ANY($2::text[])
       AND p.record->'observation'->>'listingId' = $3
       AND p.record->'observation'->>'variantId' IS NOT DISTINCT FROM $4
    UNION ALL SELECT 1 FROM formula_link
     WHERE formula_operation_id = $1 AND channel = ANY($2::text[])
       AND listing_id = $3 AND variant_id IS NOT DISTINCT FROM $4 LIMIT 1`,
    [target.request.collectionOperationId, target.channels, target.listingId, target.variantId],
  );
  if (!rows.length) {
    // The shared index may resolve a retained identity alias; require the exact requested formula.
    const known = await new PostgresFormulaIndex(database).findKnown(target);
    if (known?.operationId !== target.request.collectionOperationId) {
      throw enrichmentErrors.create("ENRICH.INPUT_MISSING");
    }
  }
}

/**
 * A backfill carries no capture to read (owner 2026-10-26): the page material read from the capture for this
 * collection's latest enrichment stands in, so the description and website variant are not lost on a re-run.
 */
async function earlierPage(
  database: Queryable,
  identity: {
    channel: string;
    listingId: string;
    variantId: string | null;
    collectionOperationId: string;
  },
) {
  const rows = await database.query<{ subject: unknown }>(
    `
    SELECT subject FROM product_enrichment_subject
     WHERE channel = $1 AND listing_id = $2 AND variant_id IS NOT DISTINCT FROM $3
       AND collection_operation_id = $4 AND subject->>'title' IS NOT NULL
     ORDER BY registered_at DESC, subject_id DESC LIMIT 1`,
    [identity.channel, identity.listingId, identity.variantId, identity.collectionOperationId],
  );
  if (!rows[0]) {
    return null;
  }
  const { title, titleEvidence, description, websiteVariant } = EnrichmentSubjectSchema.parse(
    rows[0].subject,
  );
  return {
    title,
    titleEvidence,
    ...(description === undefined ? {} : { description }),
    ...(websiteVariant ? { websiteVariant } : {}),
  };
}

function historyTitle(history: z.infer<typeof HistorySchema> | null) {
  return history?.capture.projection?.title ?? history?.capture.title ?? null;
}

function checkedHistory(row: HistoryRow | undefined) {
  if (!row) {
    return null;
  }
  if (canonicalHash(row.record) !== row.body_hash) {
    throw enrichmentErrors.create("ENRICH.INTEGRITY");
  }
  return HistorySchema.parse(row.record);
}
