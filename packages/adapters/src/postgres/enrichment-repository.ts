import type { EnrichmentRepository, FormulaFamilies } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { enrichmentErrors, enrichmentHash } from "@crawl-automation/processing";
import {
  SharedEnrichmentRecordSchema,
  SHARED_ENRICHMENT_PROTOCOL,
  type EnrichmentRequest,
  type EnrichmentSubject,
  type SharedEnrichmentRecord,
} from "@crawl-automation/v3-contracts";
import { enrichmentSource } from "./enrichment-source.js";
import { missingEnrichment } from "./enrichment-selection.js";

/** Attempts, successful results and their subjects are all append-only. */
export class PostgresEnrichmentRepository implements EnrichmentRepository {
  constructor(
    private readonly database: Queryable,
    private readonly families?: FormulaFamilies,
  ) {}

  source(request: EnrichmentRequest) {
    return enrichmentSource(
      this.database,
      request,
      this.families?.channels(request.channel) ?? [request.channel],
    );
  }
  missing(limit: number) {
    return missingEnrichment(this.database, limit);
  }

  async readSubject(request: EnrichmentRequest): Promise<SharedEnrichmentRecord | null> {
    const rows = await this.database.query<{ enrichment_id: string }>(
      `
      SELECT s.enrichment_id FROM product_enrichment_subject s
       JOIN collected_product p ON p.operation_id = s.collection_operation_id
       WHERE s.collection_operation_id = $1 AND s.channel = $2
         AND s.listing_id = coalesce($3, p.record->'observation'->>'listingId')
         AND s.variant_id IS NOT DISTINCT FROM
             CASE WHEN $5 THEN $4 ELSE p.record->'observation'->>'variantId' END
       ORDER BY s.registered_at DESC, s.subject_id DESC LIMIT 1`,
      [
        request.collectionOperationId,
        request.channel,
        request.listingId ?? null,
        request.variantId ?? null,
        request.variantId !== undefined,
      ],
    );
    return rows[0] ? this.read(rows[0].enrichment_id) : null;
  }

  async claim(inputHash: string, subject: EnrichmentSubject): Promise<boolean> {
    const rows = await this.database.query<{ input_hash: string }>(
      `
      INSERT INTO product_enrichment_attempt (input_hash, protocol, subject)
      VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING input_hash`,
      [inputHash, SHARED_ENRICHMENT_PROTOCOL, JSON.stringify(subject)],
    );
    return rows.length === 1;
  }

  async read(inputHash: string): Promise<SharedEnrichmentRecord | null> {
    const rows = await this.database.query<{ record_hash: string; record: unknown }>(
      `
      SELECT record_hash, record FROM product_enrichment WHERE enrichment_id = $1`,
      [inputHash],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const record = SharedEnrichmentRecordSchema.parse(row.record);
    if (record.enrichmentId !== inputHash || enrichmentHash(record) !== row.record_hash) {
      throw enrichmentErrors.create("ENRICH.INTEGRITY");
    }
    return record;
  }

  async register(record: SharedEnrichmentRecord): Promise<void> {
    const parsed = SharedEnrichmentRecordSchema.parse(record);
    await this.database.query(
      `
      INSERT INTO product_enrichment
        (enrichment_id, listing_id, formula_hash, protocol, collection_operation_id, record_hash, record)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT DO NOTHING`,
      [
        parsed.enrichmentId,
        parsed.subject.listingId,
        parsed.formulaHash,
        parsed.codec,
        parsed.subject.collectionOperationId,
        enrichmentHash(parsed),
        JSON.stringify(parsed),
      ],
    );
  }

  async attach(subject: EnrichmentSubject, inputHash: string): Promise<void> {
    const subjectId = enrichmentHash([subject, inputHash]);
    await this.database.query(
      `
      INSERT INTO product_enrichment_subject
        (subject_id, enrichment_id, channel, listing_id, variant_id, collection_operation_id, subject)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT DO NOTHING`,
      [
        subjectId,
        inputHash,
        subject.channel,
        subject.listingId,
        subject.variantId,
        subject.collectionOperationId,
        JSON.stringify(subject),
      ],
    );
    const rows = await this.database.query<{ enrichment_id: string }>(
      `
      SELECT enrichment_id FROM product_enrichment_subject WHERE subject_id = $1`,
      [subjectId],
    );
    if (rows[0]?.enrichment_id !== inputHash) {
      throw enrichmentErrors.create("ENRICH.INTEGRITY");
    }
  }
}
