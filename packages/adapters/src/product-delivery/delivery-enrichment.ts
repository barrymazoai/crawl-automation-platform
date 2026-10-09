import { productDeliveryErrors } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { enrichmentHash } from "@crawl-automation/processing";
import {
  EnrichmentSubjectSchema,
  type LabelCollectedProduct,
} from "@crawl-automation/v3-contracts";
import { PostgresEnrichmentRepository } from "../postgres/enrichment-repository.js";

export async function deliveryEnrichment(database: Queryable, collection: LabelCollectedProduct) {
  const owner = collection.observation;
  const rows = await database.query<{
    subject_id: string;
    enrichment_id: string;
    subject: unknown;
  }>(
    `
    SELECT subject_id, enrichment_id, subject FROM product_enrichment_subject
    WHERE collection_operation_id=$1 AND channel='dtc'
      AND listing_id=$2 AND variant_id IS NOT DISTINCT FROM $3::text
    ORDER BY registered_at DESC, subject_id DESC LIMIT 1`,
    [collection.operationId, owner.listingId, owner.variantId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const subject = EnrichmentSubjectSchema.parse(row.subject);
  const owned =
    subject.collectionOperationId === collection.operationId &&
    enrichmentHash(subject.observation) === enrichmentHash(owner);
  if (!owned || enrichmentHash([subject, row.enrichment_id]) !== row.subject_id) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
  }
  const record = await new PostgresEnrichmentRepository(database).read(row.enrichment_id);
  return record ? { ...record, subject } : null;
}
